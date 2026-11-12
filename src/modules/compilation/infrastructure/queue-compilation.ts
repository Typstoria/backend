import { HttpException } from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { AuditEvent } from '../../audit/infrastructure/persistence/entities/audit-event.entity';
import type { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { CompileJob } from './persistence/entities/compile-job.entity';

/** Lock before project rows, for both accepted-revision requests and candidate validation. */
export async function lockCompileAdmission(manager: EntityManager): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    'compile:admission',
  ]);
}

export async function queueCompilation(
  manager: EntityManager,
  actor: UserActor,
  snapshot: ProjectSnapshot,
  target: { revisionId: number } | { proposalId: number; candidateVersion: number },
  requestId: string,
): Promise<CompileJob> {
  const active = { status: In(['queued', 'running']) };
  if (
    (await manager.countBy(CompileJob, { ...active, ownerId: actor.userId })) >= 20 ||
    (await manager.countBy(CompileJob, active)) >= 200
  )
    throw new HttpException(
      {
        code: 'COMPILE_QUOTA_EXCEEDED',
        message: 'Too many pending compilations; wait for existing jobs to finish',
      },
      429,
    );
  const job = await manager.save(
    CompileJob,
    manager.create(CompileJob, {
      projectId: snapshot.projectId,
      ownerId: actor.userId,
      revisionId: 'revisionId' in target ? target.revisionId : null,
      proposalId: 'proposalId' in target ? target.proposalId : null,
      candidateVersion: 'candidateVersion' in target ? target.candidateVersion : null,
      snapshotId: snapshot.id,
      inputManifestHash: snapshot.manifestHash,
      status: 'queued',
      attempts: 0,
      compilerFingerprint: null,
      errorCode: null,
      diagnostics: [],
      artifactBlobId: null,
      artifactExpiresAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
    }),
  );
  await manager.insert(AuditEvent, {
    projectId: snapshot.projectId,
    actorId: actor.userId,
    credentialId: actor.credentialId,
    channel: actor.channel,
    action: 'compile.requested',
    requestId,
  });
  return job;
}
