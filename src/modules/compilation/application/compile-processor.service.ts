import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';
import { BlobStorage, type StoredBlob } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { Project } from '../../projects/infrastructure/persistence/entities/project.entity';
import { readSnapshotFiles } from '../../projects/infrastructure/persistence/read-snapshot-files';
import { normalizedProjectPath } from '../../projects/domain/text-changes';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import {
  ARTIFACT_TTL_MS,
  COMPILE_ATTEMPTS,
  COMPILE_LEASE_MS,
  TypstRunner,
  type CompileInput,
  type CompileResult,
} from '../domain/compilation';
import { CompileJob } from '../infrastructure/persistence/entities/compile-job.entity';

@Injectable()
export class CompileProcessor {
  constructor(
    private readonly database: DataSource,
    private readonly storage: BlobStorage,
    private readonly runner: TypstRunner,
  ) {}

  async process(id: number): Promise<void> {
    const claim = await this.claim(id);
    if (!claim) return;
    const { job, token } = claim;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.renew(job.id, token)
        .then((active) => {
          if (!active) controller.abort();
        })
        .catch(() => controller.abort());
    }, 20_000);
    try {
      let result: CompileResult;
      let artifact: StoredBlob | undefined;
      try {
        const input = await this.input(job);
        result = await this.runner.compile(input, controller.signal);
        if (result.status === 'succeeded') {
          if (!result.pdf) throw new Error('Missing PDF');
          artifact = await this.storage.put(job.ownerId, result.pdf);
        }
      } catch {
        result = {
          status: 'failed',
          errorCode: 'STORAGE_UNAVAILABLE',
          diagnostics: [],
          compilerFingerprint: '',
        };
      }
      if (!controller.signal.aborted) await this.finish(job.id, token, result, artifact);
    } finally {
      clearInterval(heartbeat);
      controller.abort();
    }
  }

  async recoverExpired(): Promise<void> {
    // Fencing happens in the predicate: a renewed/current attempt cannot be reset by this update.
    await this.database
      .createQueryBuilder()
      .update(CompileJob)
      .set({
        status: () => `CASE WHEN attempts < ${COMPILE_ATTEMPTS} THEN 'queued' ELSE 'failed' END`,
        errorCode: () =>
          `CASE WHEN attempts < ${COMPILE_ATTEMPTS} THEN NULL ELSE 'WORKER_LOST' END`,
        finishedAt: () => `CASE WHEN attempts < ${COMPILE_ATTEMPTS} THEN NULL ELSE now() END`,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: () => 'now()',
      })
      .where('status = :status AND lease_expires_at < now()', { status: 'running' })
      .execute();
  }

  private async claim(id: number): Promise<{ job: CompileJob; token: string } | undefined> {
    return this.database.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'compile:claim',
      ]);
      const job = await manager.findOne(CompileJob, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job || job.status !== 'queued' || job.availableAt.getTime() > Date.now()) return;
      if (!(await this.authorized(manager, job))) {
        await this.cancel(manager, job.id);
        return;
      }
      if (
        (await manager.countBy(CompileJob, { status: 'running' })) >= 2 ||
        (await manager.countBy(CompileJob, { status: 'running', ownerId: job.ownerId })) >= 1
      )
        return;
      const token = randomUUID();
      await manager.update(
        CompileJob,
        { id },
        {
          status: 'running',
          attempts: job.attempts + 1,
          leaseToken: token,
          leaseExpiresAt: new Date(Date.now() + COMPILE_LEASE_MS),
          startedAt: new Date(),
          errorCode: null,
        },
      );
      return { job: { ...job, attempts: job.attempts + 1 }, token };
    });
  }

  private async renew(id: number, token: string): Promise<boolean> {
    const result = await this.database.manager.update(
      CompileJob,
      { id, status: 'running', leaseToken: token, leaseExpiresAt: MoreThan(new Date()) },
      { leaseExpiresAt: new Date(Date.now() + COMPILE_LEASE_MS) },
    );
    return result.affected === 1;
  }

  private async input(job: CompileJob): Promise<CompileInput> {
    const snapshot = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
      id: job.snapshotId,
      projectId: job.projectId,
    });
    const files = await readSnapshotFiles(
      this.database.manager,
      job.projectId,
      job.snapshotId,
      job.ownerId,
    );
    const blobs = await this.database
      .getRepository(Blob)
      .createQueryBuilder('blob')
      .addSelect('blob.storageKey')
      .where('blob.ownerId = :ownerId AND blob.id IN (:...ids)', {
        ownerId: job.ownerId,
        ids: files.map((file) => file.blobId),
      })
      .getMany();
    const byId = new Map(blobs.map((blob) => [blob.id, blob]));
    const inputs: CompileInput['files'] = [];
    for (const file of files)
      inputs.push({
        fileId: file.fileId,
        path: normalizedProjectPath(file.path),
        content: await this.storage.read(job.ownerId, byId.get(file.blobId!)!),
      });
    // contextText and context materials intentionally stay outside the compiler filesystem.
    return { mainFileId: snapshot.mainFileId, files: inputs };
  }

  private async finish(
    id: number,
    token: string,
    result: CompileResult,
    artifact?: StoredBlob,
  ): Promise<void> {
    await this.database.transaction(async (manager) => {
      const job = await manager.findOne(CompileJob, {
        where: { id, status: 'running', leaseToken: token, leaseExpiresAt: MoreThan(new Date()) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) return;
      if (!(await this.authorized(manager, job))) {
        await this.cancel(manager, id);
        return;
      }
      const retry =
        ['RUNNER_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'INTERNAL_ERROR'].includes(
          result.errorCode ?? '',
        ) && job.attempts < COMPILE_ATTEMPTS;
      let artifactBlobId: number | null = null;
      if (artifact && result.status === 'succeeded') {
        await manager
          .createQueryBuilder()
          .insert()
          .into(Blob)
          .values({ ...artifact, ownerId: job.ownerId, mediaType: 'application/pdf' })
          .orIgnore()
          .execute();
        artifactBlobId = (
          await manager.findOneByOrFail(Blob, { ownerId: job.ownerId, sha256: artifact.sha256 })
        ).id;
      }
      await manager.update(
        CompileJob,
        { id, leaseToken: token },
        {
          status: retry ? 'queued' : result.status,
          errorCode: retry ? null : result.errorCode,
          compilerFingerprint: result.compilerFingerprint || null,
          diagnostics: result.diagnostics,
          leaseToken: null,
          leaseExpiresAt: null,
          availableAt: new Date(Date.now() + (retry ? job.attempts * 5000 : 0)),
          artifactBlobId,
          artifactExpiresAt: artifactBlobId ? new Date(Date.now() + ARTIFACT_TTL_MS) : null,
          finishedAt: retry ? null : new Date(),
        },
      );
    });
  }

  private async authorized(manager: EntityManager, job: CompileJob): Promise<boolean> {
    const project = await manager.findOne(Project, {
      where: { id: job.projectId, ownerId: job.ownerId, deletedAt: IsNull() },
      lock: { mode: 'pessimistic_read' },
    });
    if (!project) return false;
    return !!project;
  }

  private async cancel(manager: EntityManager, id: number): Promise<void> {
    await manager.update(
      CompileJob,
      { id },
      {
        status: 'cancelled',
        errorCode: 'ACCESS_REVOKED',
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
      },
    );
  }
}
