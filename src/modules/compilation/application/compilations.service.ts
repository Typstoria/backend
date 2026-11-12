import { requireScope } from '../../../common/actor/access-policy';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { lockCompileAdmission, queueCompilation } from '../infrastructure/queue-compilation';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { ProjectsService } from '../../projects/application/projects.service';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { CompilationDto, CreateCompilationDto } from '../http/compilation.dto';
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
