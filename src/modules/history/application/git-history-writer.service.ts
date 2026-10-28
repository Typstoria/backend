import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, LessThan, MoreThan, QueryRunner } from 'typeorm';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { Project } from '../../projects/infrastructure/persistence/entities/project.entity';
import { readSnapshotFiles } from '../../projects/infrastructure/persistence/read-snapshot-files';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import {
  GitHistoryError,
  GitRepository,
  HISTORY_ATTEMPTS,
  HISTORY_LEASE_MS,
  type GitRevisionInput,
} from '../domain/git-history';
import { GitRevisionMapping } from '../infrastructure/persistence/entities/git-revision-mapping.entity';

@Injectable()
export class GitHistoryWriter {
  constructor(
    private readonly database: DataSource,
    private readonly storage: BlobStorage,
    private readonly git: GitRepository,
  ) {}

  async process(projectId: number): Promise<void> {
    const runner = this.database.createQueryRunner();
    await runner.connect();
    const key = `history:${projectId}`;
    let locked = false;
    try {
      const [row]: Array<{ locked: boolean }> = await runner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [key],
      );
      if (!row?.locked) return;
      locked = true;
      const project = await runner.manager.findOneBy(Project, {
        id: projectId,
        deletedAt: IsNull(),
      });
      if (!project) return;
      const revisions = await runner.manager
        .createQueryBuilder(ProjectRevision, 'revision')
        .innerJoin(GitRevisionMapping, 'mapping', 'mapping.revisionId = revision.id')
        .where('revision.projectId = :projectId AND mapping.status <> :ready', {
          projectId,
          ready: 'ready',
        })
        .orderBy('revision.number', 'ASC')
        .take(100)
        .getMany();
      for (const revision of revisions) {
        if (revision.id > project.currentRevisionId) break;
        if (!(await this.writeRevision(runner, project, revision))) break;
      }
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (locked) {
        // A session lock must never return to the pool still held, even after a publication failure.
        try {
          await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        } catch {
          await runner.release();
        }
      }
      if (!runner.isReleased) await runner.release();
    }
  }

  private async writeRevision(
    runner: QueryRunner,
    project: Project,
    revision: ProjectRevision,
  ): Promise<boolean> {
    const manager = runner.manager;
    const mapping = await manager.findOneByOrFail(GitRevisionMapping, {
      revisionId: revision.id,
      projectId: project.id,
    });
    if (
      mapping.attempts >= HISTORY_ATTEMPTS ||
      mapping.availableAt.getTime() > Date.now() ||
      (mapping.leaseExpiresAt && mapping.leaseExpiresAt.getTime() > Date.now())
    )
      return false;
    let parentSha: string | null = null;
    if (revision.parentRevisionId) {
      const parent = await manager.findOneBy(GitRevisionMapping, {
        revisionId: revision.parentRevisionId,
        projectId: project.id,
        status: 'ready',
      });
      if (!parent?.commitSha) return false;
      parentSha = parent.commitSha;
    }
    const token = randomUUID();
    await manager.update(
      GitRevisionMapping,
      { revisionId: revision.id },
      {
        status: 'pending',
        attempts: mapping.attempts + 1,
        leaseToken: token,
        leaseExpiresAt: new Date(Date.now() + HISTORY_LEASE_MS),
        errorCode: null,
      },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const input = await this.input(runner, project, revision, parentSha);
      input.expectedCommitSha = mapping.commitSha;
      const sha = await this.git.write(input, controller.signal);
      if (mapping.commitSha && mapping.commitSha !== sha)
        throw new GitHistoryError('MANIFEST_MISMATCH');
      await runner.startTransaction();
      const current = await manager.findOne(Project, {
        where: { id: project.id, ownerId: project.ownerId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_read' },
      });
      if (!current) {
        await runner.rollbackTransaction();
        return false;
      }
      const updated = await manager.update(
        GitRevisionMapping,
        { revisionId: revision.id, leaseToken: token, leaseExpiresAt: MoreThan(new Date()) },
        {
          status: 'ready',
          commitSha: sha,
          parentSha,
          errorCode: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      );
      await runner.commitTransaction();
      return updated.affected === 1;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await manager.update(
        GitRevisionMapping,
        { revisionId: revision.id, leaseToken: token },
        {
          status: 'failed',
          errorCode: error instanceof GitHistoryError ? error.code : 'STORAGE_UNAVAILABLE',
          leaseToken: null,
          leaseExpiresAt: null,
          availableAt: new Date(Date.now() + Math.min(300_000, 5000 * 2 ** mapping.attempts)),
        },
      );
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async input(
    runner: QueryRunner,
    project: Project,
    revision: ProjectRevision,
    parentSha: string | null,
  ): Promise<GitRevisionInput> {
    const snapshot = await runner.manager.findOneByOrFail(ProjectSnapshot, {
      id: revision.snapshotId,
      projectId: project.id,
    });
    const files = await readSnapshotFiles(runner.manager, project.id, snapshot.id, project.ownerId);
    const blobs = await runner.manager
      .createQueryBuilder(Blob, 'blob')
      .addSelect('blob.storageKey')
      .where('blob.ownerId = :ownerId AND blob.id IN (:...ids)', {
        ownerId: project.ownerId,
        ids: files.map((file) => file.blobId),
      })
      .getMany();
    const byId = new Map(blobs.map((blob) => [blob.id, blob]));
    const source: GitRevisionInput['files'] = [];
    for (const file of files)
      source.push({
        ...file,
        bytes: await this.storage.read(project.ownerId, byId.get(file.blobId!)!),
      });
    return {
      ownerId: project.ownerId,
      projectId: project.id,
      revision,
      mainFileId: snapshot.mainFileId,
      contextText: snapshot.contextText,
      manifestHash: snapshot.manifestHash,
      files: source,
      parentSha,
      latest: revision.id === project.currentRevisionId,
    };
  }

  /** Explicit repair after repository loss or manual database recovery. Normal polling never scans ready repos. */
  async rebuild(projectId: number): Promise<void> {
    await this.database.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `history:${projectId}`,
      ]);
      const project = await manager.findOneBy(Project, { id: projectId, deletedAt: IsNull() });
      if (!project) throw new Error('Project not found');
      await manager.query(
        `
        INSERT INTO git_revision_mappings (revision_id, project_id)
        SELECT id, project_id FROM project_revisions WHERE project_id = $1
        ON CONFLICT DO NOTHING
      `,
        [projectId],
      );
      await manager.update(
        GitRevisionMapping,
        { projectId },
        {
          status: 'pending',
          attempts: 0,
          availableAt: new Date(),
          errorCode: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      );
    });
    await this.process(projectId);
    const failed = await this.database.manager.findOneBy(GitRevisionMapping, {
      projectId,
      status: 'failed',
    });
    if (failed) throw new GitHistoryError(failed.errorCode ?? 'GIT_UNAVAILABLE');
  }

  async recoverExpired(): Promise<void> {
    await this.database.manager.update(
      GitRevisionMapping,
      { status: 'pending', leaseExpiresAt: LessThan(new Date()) },
      {
        status: 'failed',
        errorCode: 'WORKER_LOST',
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: new Date(),
      },
    );
  }
}
