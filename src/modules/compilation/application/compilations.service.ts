import { requireScope } from '../../../common/actor/access-policy';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { lockCompileAdmission, queueCompilation } from '../infrastructure/queue-compilation';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { ProjectsService } from '../../projects/application/projects.service';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import {
  CompilationDto,
  CreateCompilationDto,
  WorkspaceCompilationDto,
} from '../http/compilation.dto';
import { CompileJob } from '../infrastructure/persistence/entities/compile-job.entity';

@Injectable()
export class CompilationsService {
  constructor(
    private readonly database: DataSource,
    private readonly projects: ProjectsService,
    private readonly storage: BlobStorage,
  ) {}

  async create(
    actor: UserActor,
    projectId: number,
    input: CreateCompilationDto,
    requestId: string,
  ): Promise<CompilationDto> {
    requireScope(actor, 'compile:run', 'documents:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    return this.database.transaction(async (manager) => {
      await lockCompileAdmission(manager);
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      const revision = await manager.findOneBy(ProjectRevision, {
        id: input.revisionId,
        projectId,
      });
      if (!revision) throw new NotFoundException('Revision not found');
      const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
        id: revision.snapshotId,
        projectId,
      });
      const job = await queueCompilation(
        manager,
        actor,
        snapshot,
        { revisionId: revision.id },
        requestId,
      );
      return this.dto(job, project.currentRevisionId);
    });
  }

  /** Read-only lookup: an unavailable server must never be mistaken for no PDF. */
  async latestPdf(actor: UserActor, projectId: number): Promise<WorkspaceCompilationDto> {
    requireScope(actor, 'compile:read', 'documents:read');
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    const job = await this.latestPdfJob(this.database.manager, actor.userId, projectId);
    if (!job) return { job: null, revisionNumber: null };
    const result = await this.workspaceDto(this.database.manager, job, project.currentRevisionId);
    // Expiry can pass while reading revision metadata; do not advertise an
    // already-unavailable artifact as a successful latest lookup.
    return result.job?.artifactAvailable ? result : { job: null, revisionNumber: null };
  }

  /** Recheck under the same admission/project locks as manual compilation.
   * Concurrent openings and a lost response can reuse a pending or completed result.
   */
  async ensure(
    actor: UserActor,
    projectId: number,
    requestId: string,
  ): Promise<WorkspaceCompilationDto> {
    requireScope(actor, 'compile:read', 'compile:run', 'documents:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    return this.database.transaction(async (manager) => {
      await lockCompileAdmission(manager);
      // Publication also locks the project: no successful result can appear in the
      // gap between checking the latest PDF and checking queued/running work.
      const project = await this.projects.ownedProject(manager, actor, projectId, true);
      let job = await this.latestPdfJob(manager, actor.userId, projectId);
      job ??= await manager.findOne(CompileJob, {
        where: {
          projectId,
          ownerId: actor.userId,
          revisionId: project.currentRevisionId,
          status: In(['queued', 'running']),
        },
        order: { id: 'DESC' },
      });
      if (!job) {
        const revision = await manager.findOneByOrFail(ProjectRevision, {
          id: project.currentRevisionId,
          projectId,
        });
        const snapshot = await manager.findOneByOrFail(ProjectSnapshot, {
          id: revision.snapshotId,
          projectId,
        });
        job = await queueCompilation(
          manager,
          actor,
          snapshot,
          { revisionId: revision.id },
          requestId,
        );
      }
      return this.workspaceDto(manager, job, project.currentRevisionId);
    });
  }

  private latestPdfJob(
    manager: EntityManager,
    ownerId: number,
    projectId: number,
  ): Promise<CompileJob | null> {
    return manager
      .getRepository(CompileJob)
      .createQueryBuilder('job')
      .innerJoin(
        ProjectRevision,
        'revision',
        'revision.id = job.revisionId AND revision.projectId = job.projectId',
      )
      .where('job.ownerId = :ownerId AND job.projectId = :projectId', { ownerId, projectId })
      .andWhere('job.proposalId IS NULL AND job.revisionId IS NOT NULL')
      .andWhere('job.status = :status', { status: 'succeeded' })
      .andWhere('job.artifactBlobId IS NOT NULL AND job.artifactExpiresAt > :now', {
        now: new Date(),
      })
      .orderBy('revision.number', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .getOne();
  }

  private async workspaceDto(
    manager: EntityManager,
    job: CompileJob,
    headId: number,
  ): Promise<WorkspaceCompilationDto> {
    const revision = await manager.findOneByOrFail(ProjectRevision, {
      id: job.revisionId!,
      projectId: job.projectId,
    });
    return { job: this.dto(job, headId), revisionNumber: revision.number };
  }

  async get(actor: UserActor, projectId: number, id: number): Promise<CompilationDto> {
    requireScope(actor, 'compile:read', 'documents:read');
    const project = await this.projects.ownedProject(this.database.manager, actor, projectId);
    const job = await this.database.manager.findOneBy(CompileJob, {
      id,
      projectId,
      ownerId: actor.userId,
    });
    if (!job) throw new NotFoundException('Compilation not found');
    if (job.proposalId !== null) requireScope(actor, 'changes:read');
    return this.dto(job, project.currentRevisionId);
  }

  async pdf(actor: UserActor, projectId: number, id: number): Promise<Buffer> {
    requireScope(actor, 'compile:read', 'documents:read');
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const job = await this.database
      .getRepository(CompileJob)
      .createQueryBuilder('job')
      .addSelect('job.artifactBlobId')
      .where('job.id = :id AND job.projectId = :projectId AND job.ownerId = :ownerId', {
        id,
        projectId,
        ownerId: actor.userId,
      })
      .getOne();
    if (!job) throw new NotFoundException('Compilation not found');
    if (job.proposalId !== null) requireScope(actor, 'changes:read');
    if (!this.available(job) || !job.artifactBlobId)
      throw new ConflictException({
        code: 'ARTIFACT_UNAVAILABLE',
        message: 'This job has no available PDF; inspect its status or request a new compilation',
      });
    const blob = await this.database
      .getRepository(Blob)
      .createQueryBuilder('blob')
      .addSelect('blob.storageKey')
      .where('blob.id = :id AND blob.ownerId = :ownerId', {
        id: job.artifactBlobId,
        ownerId: actor.userId,
      })
      .getOneOrFail();
    return this.storage.read(actor.userId, blob);
  }

  private available(job: CompileJob): boolean {
    return (
      job.status === 'succeeded' &&
      job.artifactExpiresAt !== null &&
      job.artifactExpiresAt.getTime() > Date.now()
    );
  }

  private dto(job: CompileJob, currentRevisionId: number): CompilationDto {
    return {
      id: job.id,
      projectId: job.projectId,
      revisionId: job.revisionId,
      proposalId: job.proposalId,
      candidateVersion: job.candidateVersion,
      candidateSnapshotId: job.proposalId === null ? null : job.snapshotId,
      status: job.status,
      errorCode: job.errorCode,
      inputManifestHash: job.inputManifestHash,
      compilerFingerprint: job.compilerFingerprint,
      isCurrent: job.revisionId === currentRevisionId,
      artifactAvailable: this.available(job),
      artifactExpiresAt: job.artifactExpiresAt?.toISOString() ?? null,
      diagnostics: job.diagnostics,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }
}
