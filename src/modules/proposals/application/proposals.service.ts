import { requireScope } from '../../../common/actor/access-policy';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { AuditEvent } from '../../audit/infrastructure/persistence/entities/audit-event.entity';
import {
  lockCompileAdmission,
  queueCompilation,
} from '../../compilation/infrastructure/queue-compilation';
import { CompileJob } from '../../compilation/infrastructure/persistence/entities/compile-job.entity';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { RevisionDiffService } from '../../history/application/revision-diff.service';
import { GitRevisionMapping } from '../../history/infrastructure/persistence/entities/git-revision-mapping.entity';
import { ProjectsService } from '../../projects/application/projects.service';
import { ProjectUploadsService } from '../../projects/application/project-uploads.service';
import { applyTextChanges } from '../../projects/domain/text-changes';
import {
  checkIdempotencyPayload,
  mutationPayloadHash,
  requireIdempotencyKey,
} from '../../projects/domain/idempotency';
import { IdempotencyRecord } from '../../projects/infrastructure/persistence/entities/idempotency-record.entity';
import { Project } from '../../projects/infrastructure/persistence/entities/project.entity';
import { readSnapshotFiles } from '../../projects/infrastructure/persistence/read-snapshot-files';
import { snapshotManifestHash } from '../../revisions/domain/snapshot-manifest';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { SnapshotFile } from '../../revisions/infrastructure/persistence/entities/snapshot-file.entity';
import { stageSnapshot, writeSnapshot } from '../../revisions/infrastructure/write-snapshot';
import type { ListProjectsQueryDto, ProjectFileDto } from '../../projects/http/projects.dto';
import type {
  CreateProposalDto,
  UpdateProposalDto,
  RebaseProposalDto,
  AcceptProposalDto,
  ProposalDto,
  ProposalListDto,
  ProposalCandidateDto,
  ProposalDiffDto,
  ProposalValidationDto,
  ProposalAcceptedDto,
  ProposalTextFileDto,
} from '../http/proposals.dto';
import { Proposal } from '../infrastructure/persistence/entities/proposal.entity';
import { ProposalCandidate } from '../infrastructure/persistence/entities/proposal-candidate.entity';
import { ProposalValidation } from '../infrastructure/persistence/entities/proposal-validation.entity';

const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class ProposalsService {
  constructor(
    private readonly database: DataSource,
    private readonly projects: ProjectsService,
    private readonly uploads: ProjectUploadsService,
    private readonly storage: BlobStorage,
    private readonly diffs: RevisionDiffService,
  ) {}

  async create(
    actor: UserActor,
    projectId: number,
    input: CreateProposalDto,
    requestId: string,
  ): Promise<ProposalDto> {
    requireScope(actor, 'changes:propose');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const prepared = await this.prepare(actor, projectId, input);
    return this.database.transaction(async (manager) => {
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      const counts: { count: number }[] = await manager.query(
        "SELECT count(*)::int AS count FROM proposals WHERE project_id=$1 AND status='draft' AND expires_at>now()",
        [projectId],
      );
      if (counts[0]!.count >= 50)
        throw new HttpException(
          { code: 'PROPOSAL_QUOTA_EXCEEDED', message: 'At most 50 active proposals per project' },
          429,
        );
      await this.uploads.resources(manager, actor, projectId, prepared.uploadIds);
      const proposal = await manager.save(
        Proposal,
        manager.create(Proposal, {
          projectId,
          creatorId: actor.userId,
          channel: actor.channel,
          status: 'draft',
          version: 1,
          acceptedRevisionId: null,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        }),
      );
      const { snapshot } = await writeSnapshot(
        manager,
        actor.userId,
        projectId,
        prepared.draft,
        prepared.staged,
      );
      await manager.insert(ProposalCandidate, {
        proposalId: proposal.id,
        projectId,
        version: 1,
        baseRevisionId: input.baseRevisionId,
        snapshotId: snapshot.id,
        summary: input.summary ?? 'Proposed changes',
        operations: input.operations,
      });
      await this.audit(manager, actor, projectId, 'proposal.created', requestId);
      return this.describe(manager, proposal, project.currentRevisionId);
    });
  }

  async list(
    actor: UserActor,
    projectId: number,
    query: ListProjectsQueryDto,
  ): Promise<ProposalListDto> {
    requireScope(actor, 'changes:read');
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    const builder = this.database
      .getRepository(Proposal)
      .createQueryBuilder('proposal')
      .where('proposal.projectId = :projectId', { projectId })
      .orderBy('proposal.id', 'DESC')
      .take(query.limit + 1);
    if (query.cursor !== undefined)
      builder.andWhere('proposal.id < :cursor', { cursor: query.cursor });
    const rows = await builder.getMany();
    const items = await Promise.all(
      rows
        .slice(0, query.limit)
        .map((row) => this.describe(this.database.manager, row, project.currentRevisionId)),
    );
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }

  async get(actor: UserActor, projectId: number, id: number): Promise<ProposalDto> {
    requireScope(actor, 'changes:read');
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    return this.describe(
      this.database.manager,
      await this.owned(this.database.manager, projectId, id),
      project.currentRevisionId,
    );
  }

  async update(
    actor: UserActor,
    projectId: number,
    id: number,
    input: UpdateProposalDto,
    requestId: string,
  ): Promise<ProposalDto> {
    requireScope(actor, 'changes:propose');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const proposal = await this.owned(this.database.manager, projectId, id);
    this.editable(proposal, input.expectedProposalVersion);
    const candidate = await this.candidate(this.database.manager, proposal);
    return this.replace(
      actor,
      projectId,
      id,
      {
        ...input,
        baseRevisionId: candidate.baseRevisionId,
        summary: input.summary ?? candidate.summary,
      },
      requestId,
      false,
    );
  }

  async rebase(
    actor: UserActor,
    projectId: number,
    id: number,
    input: RebaseProposalDto,
    requestId: string,
  ): Promise<ProposalDto> {
    requireScope(actor, 'changes:propose');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    this.editable(
      await this.owned(this.database.manager, projectId, id),
      input.expectedProposalVersion,
    );
    return this.replace(actor, projectId, id, input, requestId, true);
  }

  private async replace(
    actor: UserActor,
    projectId: number,
    id: number,
    input: RebaseProposalDto,
    requestId: string,
    rebasing: boolean,
  ): Promise<ProposalDto> {
    const prepared = await this.prepare(actor, projectId, input);
    return this.database.transaction(async (manager) => {
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      const proposal = await this.owned(manager, projectId, id, true);
      this.editable(proposal, input.expectedProposalVersion);
      if (proposal.version >= 100)
        throw new ConflictException({
          code: 'PROPOSAL_VERSION_LIMIT',
          message: 'Create a new proposal after 100 candidate versions',
        });
      if (rebasing && project.currentRevisionId !== input.baseRevisionId)
        throw this.stale(project.currentRevisionId);
      await this.uploads.resources(manager, actor, projectId, prepared.uploadIds);
      const { snapshot } = await writeSnapshot(
        manager,
        actor.userId,
        projectId,
        prepared.draft,
        prepared.staged,
      );
      proposal.version++;
      await manager.insert(ProposalCandidate, {
        proposalId: id,
        projectId,
        version: proposal.version,
        baseRevisionId: input.baseRevisionId,
        snapshotId: snapshot.id,
        summary: input.summary ?? 'Proposed changes',
        operations: input.operations,
      });
      await manager.save(Proposal, proposal);
      await this.audit(
        manager,
        actor,
        projectId,
        rebasing ? 'proposal.rebased' : 'proposal.updated',
        requestId,
      );
      return this.describe(manager, proposal, project.currentRevisionId);
    });
  }

  async state(
    actor: UserActor,
    projectId: number,
    id: number,
    version?: number,
  ): Promise<ProposalCandidateDto> {
    requireScope(actor, 'changes:read', 'documents:read', 'context:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const candidate = await this.candidate(
      this.database.manager,
      await this.owned(this.database.manager, projectId, id),
      version,
    );
    const snapshot = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
      id: candidate.snapshotId,
      projectId,
    });
    const files = await readSnapshotFiles(
      this.database.manager,
      projectId,
      snapshot.id,
      actor.userId,
    );
    const stored = await this.database
      .getRepository(ProposalCandidate)
      .createQueryBuilder('candidate')
      .addSelect('candidate.operations')
      .where('candidate.id = :id', { id: candidate.id })
      .getOneOrFail();
    return {
      operations: stored.operations,
      proposalId: id,
      candidateVersion: candidate.version,
      baseRevisionId: candidate.baseRevisionId,
      candidateSnapshotId: snapshot.id,
      candidateManifestHash: snapshot.manifestHash,
      mainFileId: snapshot.mainFileId,
      contextText: snapshot.contextText,
      directories: [...snapshot.directories].sort(),
      tree: files.map(this.fileMetadata),
    };
  }

  async file(actor: UserActor, projectId: number, id: number, fileId: number, version?: number) {
    requireScope(actor, 'changes:read', 'documents:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const candidate = await this.candidate(
      this.database.manager,
      await this.owned(this.database.manager, projectId, id),
      version,
    );
    const file = await this.database.manager.findOneBy(SnapshotFile, {
      snapshotId: candidate.snapshotId,
      projectId,
      fileId,
      ownerId: actor.userId,
    });
    if (!file) throw new NotFoundException('File not found in proposal candidate');
    const blob = await this.database
      .getRepository(Blob)
      .createQueryBuilder('blob')
      .addSelect('blob.storageKey')
      .where('blob.id = :id AND blob.ownerId = :owner', { id: file.blobId, owner: actor.userId })
      .getOneOrFail();
    return {
      metadata: {
        fileId,
        path: file.normalizedPath,
        contentKind: file.contentKind,
        mediaType: file.mediaType,
        sizeBytes: blob.sizeBytes,
        sha256: blob.sha256,
      },
      content: await this.storage.read(actor.userId, blob),
      candidateVersion: candidate.version,
    };
  }

  async textFile(
    actor: UserActor,
    projectId: number,
    id: number,
    fileId: number,
    version?: number,
  ): Promise<ProposalTextFileDto> {
    const file = await this.file(actor, projectId, id, fileId, version);
    if (file.metadata.contentKind !== 'text')
      throw new UnprocessableEntityException({
        code: 'NOT_A_TEXT_FILE',
        message: 'Use the candidate file download endpoint for binary files',
      });
    return {
      ...file.metadata,
      candidateVersion: file.candidateVersion,
      content: file.content.toString('utf8'),
    };
  }

  async diff(
    actor: UserActor,
    projectId: number,
    id: number,
    version?: number,
  ): Promise<ProposalDiffDto> {
    requireScope(actor, 'changes:read', 'documents:read', 'context:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const candidate = await this.candidate(
      this.database.manager,
      await this.owned(this.database.manager, projectId, id),
      version,
    );
    const base = await this.database.manager.findOneByOrFail(ProjectRevision, {
      id: candidate.baseRevisionId,
      projectId,
    });
    const snapshot = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
      id: candidate.snapshotId,
      projectId,
    });
    return {
      baseRevisionId: base.id,
      proposalId: id,
      candidateVersion: candidate.version,
      candidateManifestHash: snapshot.manifestHash,
      ...(await this.diffs.snapshots(actor, projectId, base.snapshotId, snapshot.id)),
    };
  }

  async validate(
    actor: UserActor,
    projectId: number,
    id: number,
    version: number,
    requestId: string,
  ): Promise<ProposalValidationDto> {
    requireScope(actor, 'changes:propose');
    return this.database.transaction(async (manager) => {
      await lockCompileAdmission(manager);
      await this.projects.ownedProject(manager, actor, projectId, true);
      const proposal = await this.owned(manager, projectId, id, true);
      this.editable(proposal, version);
      const candidate = await this.candidate(manager, proposal);
      const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
        id: candidate.snapshotId,
        projectId,
      });
      const base = await manager.findOneByOrFail(ProjectRevision, {
        id: candidate.baseRevisionId,
        projectId,
      });
      const inputHash = async (snapshotId: number) => {
        const state = await manager.findOneByOrFail(ProjectSnapshot, { id: snapshotId, projectId });
        return snapshotManifestHash({
          mainFileId: state.mainFileId,
          contextText: '',
          files: await readSnapshotFiles(manager, projectId, snapshotId, actor.userId),
        });
      };
      const needsCompile = (await inputHash(snapshot.id)) !== (await inputHash(base.snapshotId));
      if (needsCompile) requireScope(actor, 'compile:run', 'documents:read');
      const job = needsCompile
        ? await queueCompilation(
            manager,
            actor,
            snapshot,
            { proposalId: id, candidateVersion: candidate.version },
            requestId,
          )
        : null;
      const validation = await manager.save(
        ProposalValidation,
        manager.create(ProposalValidation, {
          proposalId: id,
          projectId,
          candidateVersion: candidate.version,
          snapshotId: snapshot.id,
          compileJobId: job?.id ?? null,
        }),
      );
      await this.audit(manager, actor, projectId, 'proposal.validated', requestId);
      return this.validationDto(manager, validation);
    });
  }

  async validation(
    actor: UserActor,
    projectId: number,
    id: number,
    validationId: number,
  ): Promise<ProposalValidationDto> {
    requireScope(actor, 'changes:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    await this.owned(this.database.manager, projectId, id);
    const validation = await this.database.manager.findOneBy(ProposalValidation, {
      id: validationId,
      projectId,
      proposalId: id,
    });
    if (!validation) throw new NotFoundException('Validation not found');
    if (validation.compileJobId !== null) requireScope(actor, 'compile:read', 'documents:read');
    return this.validationDto(this.database.manager, validation);
  }

  async accept(
    actor: UserActor,
    projectId: number,
    id: number,
    input: AcceptProposalDto,
    key: string | undefined,
    requestId: string,
  ): Promise<ProposalAcceptedDto> {
    this.webOnly(actor);
    key = requireIdempotencyKey(key);
    const payloadHash = mutationPayloadHash(input);
    return this.database.transaction(async (manager) => {
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      const proposal = await this.owned(manager, projectId, id, true);
      const lookup = {
        sessionId: actor.credentialId,
        operation: `projects:${projectId}:proposals:${id}:accept`,
        key,
      };
      const previous = await manager.findOneBy(IdempotencyRecord, lookup);
      if (previous) {
        checkIdempotencyPayload(previous.payloadHash, payloadHash);
        return { ...previous.result, proposalId: id };
      }
      this.editable(proposal, input.expectedProposalVersion);
      const candidate = await this.candidate(manager, proposal);
      if (
        project.currentRevisionId !== candidate.baseRevisionId ||
        input.baseRevisionId !== candidate.baseRevisionId
      )
        throw this.stale(project.currentRevisionId);
      const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
        id: candidate.snapshotId,
        projectId,
      });
      if (snapshot.manifestHash !== input.candidateManifestHash)
        throw new ConflictException({
          code: 'CANDIDATE_CONFLICT',
          message: 'Review the exact candidate manifest before accepting',
        });
      const validation = await manager.findOneBy(ProposalValidation, {
        id: input.validationId,
        proposalId: id,
        projectId,
        candidateVersion: candidate.version,
        snapshotId: snapshot.id,
      });
      if (!validation)
        throw new ConflictException({
          code: 'VALIDATION_REQUIRED',
          message: 'Validate the current candidate version before accepting',
        });
      const checked = await this.validationDto(manager, validation);
      if (checked.status === 'compile_failed' && !input.acknowledgeCompileFailure)
        throw new ConflictException({
          code: 'COMPILE_FAILURE_ACK_REQUIRED',
          message: 'Inspect Typst diagnostics and explicitly acknowledge this failed compilation',
        });
      if (
        ![
          'succeeded',
          'not_required',
          ...(input.acknowledgeCompileFailure ? ['compile_failed'] : []),
        ].includes(checked.status)
      )
        throw new ConflictException({
          code: 'VALIDATION_REQUIRED',
          message:
            'Wait for a successful validation; infrastructure failures cannot be acknowledged',
        });
      const current = await manager.findOneByOrFail(ProjectRevision, {
        id: project.currentRevisionId,
        projectId,
      });
      const currentSnapshot = await manager.findOneByOrFail(ProjectSnapshot, {
        id: current.snapshotId,
        projectId,
      });
      let accepted = current;
      if (currentSnapshot.manifestHash !== snapshot.manifestHash) {
        accepted = await manager.save(
          ProjectRevision,
          manager.create(ProjectRevision, {
            projectId,
            number: project.nextRevisionNumber,
            parentRevisionId: current.id,
            snapshotId: snapshot.id,
            actorId: proposal.creatorId,
            channel: proposal.channel,
            operation: 'proposal',
            summary: candidate.summary,
          }),
        );
        await manager.update(
          Project,
          { id: projectId },
          { currentRevisionId: accepted.id, nextRevisionNumber: accepted.number + 1 },
        );
        await manager.insert(GitRevisionMapping, { revisionId: accepted.id, projectId });
      }
      await manager.update(
        Proposal,
        { id },
        { status: 'accepted', acceptedRevisionId: accepted.id },
      );
      await this.audit(manager, actor, projectId, 'proposal.accepted', requestId);
      const mapping = await manager.findOneBy(GitRevisionMapping, {
        revisionId: accepted.id,
        projectId,
      });
      const result: ProposalAcceptedDto = {
        proposalId: id,
        projectId,
        revisionId: accepted.id,
        revisionNumber: accepted.number,
        mainFileId: snapshot.mainFileId,
        manifestHash: snapshot.manifestHash,
        historySyncStatus: mapping?.status ?? 'pending',
      };
      await manager.insert(IdempotencyRecord, { ...lookup, projectId, payloadHash, result });
      return result;
    });
  }

  async reject(
    actor: UserActor,
    projectId: number,
    id: number,
    version: number,
    requestId: string,
  ): Promise<ProposalDto> {
    this.webOnly(actor);
    return this.database.transaction(async (manager) => {
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      const proposal = await this.owned(manager, projectId, id, true);
      if (proposal.status === 'rejected' && proposal.version === version)
        return this.describe(manager, proposal, project.currentRevisionId);
      this.editable(proposal, version);
      proposal.status = 'rejected';
      await manager.save(Proposal, proposal);
      await this.audit(manager, actor, projectId, 'proposal.rejected', requestId);
      return this.describe(manager, proposal, project.currentRevisionId);
    });
  }

  private async prepare(actor: UserActor, projectId: number, input: CreateProposalDto) {
    for (const operation of input.operations) {
      if (operation.type === 'updateContext') requireScope(actor, 'context:read');
      else requireScope(actor, 'documents:read');
      if ('uploadId' in operation) requireScope(actor, 'uploads:stage');
    }
    const revision = await this.database.manager.findOneBy(ProjectRevision, {
      id: input.baseRevisionId,
      projectId,
    });
    if (!revision) throw new NotFoundException('Base revision not found');
    const base = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
      id: revision.snapshotId,
      projectId,
    });
    const uploadIds = [
      ...new Set(
        input.operations.flatMap((operation) =>
          'uploadId' in operation ? [operation.uploadId] : [],
        ),
      ),
    ];
    const resources = await this.uploads.resources(
      this.database.manager,
      actor,
      projectId,
      uploadIds,
    );
    const draft = applyTextChanges(
      {
        mainFileId: base.mainFileId,
        contextText: base.contextText,
        directories: base.directories,
        files: await readSnapshotFiles(this.database.manager, projectId, base.id, actor.userId),
      },
      input.operations,
      resources,
    );
    return { draft, uploadIds, staged: await stageSnapshot(this.storage, actor.userId, draft) };
  }

  private async owned(
    manager: EntityManager,
    projectId: number,
    id: number,
    lock = false,
  ): Promise<Proposal> {
    const proposal = await manager.findOne(Proposal, {
      where: { id, projectId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  private async candidate(
    manager: EntityManager,
    proposal: Proposal,
    version = proposal.version,
  ): Promise<ProposalCandidate> {
    const candidate = await manager.findOneBy(ProposalCandidate, {
      proposalId: proposal.id,
      projectId: proposal.projectId,
      version,
    });
    if (!candidate) throw new NotFoundException('Candidate version not found');
    return candidate;
  }

  private editable(proposal: Proposal, expected: number): void {
    if (proposal.version !== expected)
      throw new ConflictException({
        code: 'PROPOSAL_VERSION_CONFLICT',
        message: 'Reload the latest proposal version',
        details: { currentProposalVersion: proposal.version },
      });
    if (proposal.status !== 'draft')
      throw new ConflictException({
        code: 'PROPOSAL_CLOSED',
        message: 'This proposal is already accepted or rejected',
      });
    if (proposal.expiresAt.getTime() <= Date.now())
      throw new ConflictException({
        code: 'PROPOSAL_EXPIRED',
        message: 'Create a new proposal after expiry',
      });
  }

  private async describe(
    manager: EntityManager,
    proposal: Proposal,
    currentRevisionId: number,
  ): Promise<ProposalDto> {
    const candidate = await this.candidate(manager, proposal);
    const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
      id: candidate.snapshotId,
      projectId: proposal.projectId,
    });
    const validation = await manager.findOne(ProposalValidation, {
      where: {
        proposalId: proposal.id,
        candidateVersion: proposal.version,
        projectId: proposal.projectId,
      },
      order: { id: 'DESC' },
    });
    return {
      id: proposal.id,
      projectId: proposal.projectId,
      creatorId: proposal.creatorId,
      channel: proposal.channel,
      status:
        proposal.status === 'draft' && proposal.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : proposal.status,
      version: proposal.version,
      baseRevisionId: candidate.baseRevisionId,
      candidateSnapshotId: snapshot.id,
      candidateManifestHash: snapshot.manifestHash,
      summary: candidate.summary,
      isStale: candidate.baseRevisionId !== currentRevisionId,
      acceptedRevisionId: proposal.acceptedRevisionId,
      latestValidationId: validation?.id ?? null,
      createdAt: proposal.createdAt.toISOString(),
      expiresAt: proposal.expiresAt.toISOString(),
    };
  }

  private async validationDto(
    manager: EntityManager,
    validation: ProposalValidation,
  ): Promise<ProposalValidationDto> {
    const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
      id: validation.snapshotId,
      projectId: validation.projectId,
    });
    const job =
      validation.compileJobId === null
        ? null
        : await manager.findOneBy(CompileJob, {
            id: validation.compileJobId,
            projectId: validation.projectId,
            proposalId: validation.proposalId,
            candidateVersion: validation.candidateVersion,
            snapshotId: validation.snapshotId,
            inputManifestHash: snapshot.manifestHash,
          });
    const status =
      validation.compileJobId === null
        ? 'not_required'
        : !job
          ? 'validation_failed'
          : job.status === 'succeeded'
            ? 'succeeded'
            : job.status === 'queued' || job.status === 'running'
              ? job.status
              : job.status === 'failed' && job.errorCode === 'TYPST_ERROR'
                ? 'compile_failed'
                : 'validation_failed';
    return {
      id: validation.id,
      proposalId: validation.proposalId,
      candidateVersion: validation.candidateVersion,
      candidateManifestHash: snapshot.manifestHash,
      status,
      compileJobId: validation.compileJobId,
      errorCode: job?.errorCode ?? null,
      diagnostics: job?.diagnostics ?? [],
      createdAt: validation.createdAt.toISOString(),
    };
  }

  private fileMetadata(file: {
    fileId: number;
    path: string;
    contentKind: 'text' | 'binary';
    sha256: string;
    sizeBytes: number;
    mediaType: string;
  }): ProjectFileDto {
    const { fileId, path, contentKind, sha256, sizeBytes, mediaType } = file;
    return { fileId, path, contentKind, sha256, sizeBytes, mediaType };
  }

  private webOnly(actor: UserActor): void {
    if (actor.channel !== 'web')
      throw new ForbiddenException({
        code: 'WEB_REVIEW_REQUIRED',
        message: 'Only the owner web session can accept or reject proposals',
      });
  }

  private stale(currentRevisionId: number): ConflictException {
    return new ConflictException({
      code: 'REVISION_CONFLICT',
      message: 'Rebase the proposal onto the current revision',
      details: { currentRevisionId },
    });
  }

  private async audit(
    manager: EntityManager,
    actor: UserActor,
    projectId: number,
    action: string,
    requestId: string,
  ): Promise<void> {
    await manager.insert(AuditEvent, {
      projectId,
      actorId: actor.userId,
      channel: actor.channel,
      credentialId: actor.credentialId,
      action,
      requestId,
    });
  }
}
