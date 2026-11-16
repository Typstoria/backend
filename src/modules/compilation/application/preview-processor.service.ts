import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull, MoreThan } from 'typeorm';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { Project } from '../../projects/infrastructure/persistence/entities/project.entity';
import { TypstRunner, COMPILE_LEASE_MS, COMPILE_ATTEMPTS } from '../domain/compilation';
import { CompileJob } from '../infrastructure/persistence/entities/compile-job.entity';
import { CompileProcessor } from './compile-processor.service';

/** A separate durable stage: preview failures never change a completed PDF job. */
@Injectable()
export class PreviewProcessor {
  constructor(
    private readonly database: DataSource,
    private readonly storage: BlobStorage,
    private readonly runner: TypstRunner,
    private readonly compiler: CompileProcessor,
  ) {}

  async recoverExpired(): Promise<void> {
    await this.database.query(`UPDATE compile_jobs SET
      preview_status = CASE WHEN preview_attempts < 3 THEN 'queued' ELSE 'failed' END,
      preview_available_at = now(), preview_lease_token = NULL, preview_lease_expires_at = NULL
      WHERE preview_status = 'running' AND preview_lease_expires_at < now()`);
  }

  async process(id: number): Promise<void> {
    const claim = await this.claim(id);
    if (!claim) return;
    const { job, token } = claim;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.database.manager
        .update(
          CompileJob,
          {
            id,
            previewStatus: 'running',
            previewLeaseToken: token,
            previewLeaseExpiresAt: MoreThan(new Date()),
          },
          { previewLeaseExpiresAt: new Date(Date.now() + COMPILE_LEASE_MS) },
        )
        .then((result) => {
          if (!result.affected) controller.abort();
        })
        .catch(() => controller.abort());
    }, 20_000);
    try {
      const png = await this.runner.preview(await this.compiler.input(job), controller.signal);
      const stored = await this.storage.put(job.ownerId, png);
      if (controller.signal.aborted) return;
      await this.database.transaction(async (manager) => {
        const current = await manager.findOne(CompileJob, {
          where: {
            id,
            previewStatus: 'running',
            previewLeaseToken: token,
            previewLeaseExpiresAt: MoreThan(new Date()),
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current) return;
        const project = await manager.findOne(Project, {
          where: { id: job.projectId, ownerId: job.ownerId, deletedAt: IsNull() },
          lock: { mode: 'pessimistic_write' },
        });
        if (project) {
          await manager
            .createQueryBuilder()
            .insert()
            .into(Blob)
            .values({ ...stored, ownerId: job.ownerId, mediaType: 'image/png' })
            .orIgnore()
            .execute();
          const blob = await manager.findOneByOrFail(Blob, {
            ownerId: job.ownerId,
            sha256: stored.sha256,
          });
          // Compare revision first, then request order. An old revision compiled later
          // must never replace a newer cover. Raw SQL deliberately preserves updated_at.
          await manager.query(
            `UPDATE projects SET preview_blob_id = $1, preview_version = $2,
            preview_revision_id = $3, preview_job_id = $4
            WHERE id = $5 AND owner_id = $6 AND deleted_at IS NULL
              AND (preview_revision_id IS NULL OR preview_revision_id < $3
                OR (preview_revision_id = $3 AND preview_job_id < $4))`,
            [blob.id, stored.sha256, job.revisionId, id, job.projectId, job.ownerId],
          );
        }
        await manager.update(
          CompileJob,
          { id },
          {
            previewStatus: project ? 'ready' : 'skipped',
            previewLeaseToken: null,
            previewLeaseExpiresAt: null,
          },
        );
      });
    } catch {
      if (!controller.signal.aborted)
        await this.database.manager.update(
          CompileJob,
          {
            id,
            previewStatus: 'running',
            previewLeaseToken: token,
            previewLeaseExpiresAt: MoreThan(new Date()),
          },
          {
            previewStatus: job.previewAttempts < COMPILE_ATTEMPTS ? 'queued' : 'failed',
            previewAvailableAt: new Date(Date.now() + job.previewAttempts * 5000),
            previewLeaseToken: null,
            previewLeaseExpiresAt: null,
          },
        );
    } finally {
      clearInterval(heartbeat);
      controller.abort();
    }
  }

  private async claim(id: number): Promise<{ job: CompileJob; token: string } | undefined> {
    return this.database.transaction(async (manager) => {
      // Compile and preview stages share the global/owner CPU admission limits.
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'compile:claim',
      ]);
      const job = await manager.findOne(CompileJob, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !job ||
        job.previewStatus !== 'queued' ||
        !job.previewAvailableAt ||
        job.previewAvailableAt.getTime() > Date.now()
      )
        return;
      const project = await manager.findOneBy(Project, {
        id: job.projectId,
        ownerId: job.ownerId,
        deletedAt: IsNull(),
      });
      if (
        !project ||
        job.status !== 'succeeded' ||
        job.proposalId !== null ||
        job.revisionId === null ||
        (project.previewRevisionId !== null && project.previewRevisionId > job.revisionId)
      ) {
        await manager.update(CompileJob, { id }, { previewStatus: 'skipped' });
        return;
      }
      if (
        (await manager.countBy(CompileJob, [
          { status: 'running' },
          { previewStatus: 'running' },
        ])) >= 2 ||
        (await manager.countBy(CompileJob, [
          { status: 'running', ownerId: job.ownerId },
          { previewStatus: 'running', ownerId: job.ownerId },
        ])) >= 1
      )
        return;
      const token = randomUUID();
      await manager.update(
        CompileJob,
        { id },
        {
          previewStatus: 'running',
          previewAttempts: job.previewAttempts + 1,
          previewLeaseToken: token,
          previewLeaseExpiresAt: new Date(Date.now() + COMPILE_LEASE_MS),
        },
      );
      return { job: { ...job, previewAttempts: job.previewAttempts + 1 }, token };
    });
  }
}
