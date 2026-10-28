import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  CompileDiagnostic,
  CompileErrorCode,
  CompileStatus,
} from '../../../domain/compilation';

@Entity({ name: 'compile_jobs' })
@Index('compile_jobs_dispatch_idx', ['status', 'availableAt'])
@Index('compile_jobs_owner_status_idx', ['ownerId', 'status'])
@Check(
  'compile_jobs_status_check',
  `"status" IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')`,
)
@Check('compile_jobs_attempts_check', '"attempts" >= 0 AND "attempts" <= 3')
@ForeignKey('Project', ['projectId', 'ownerId'], ['id', 'ownerId'], {
  name: 'compile_jobs_project_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('ProjectRevision', ['revisionId', 'projectId'], ['id', 'projectId'], {
  name: 'compile_jobs_revision_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('ProjectSnapshot', ['snapshotId', 'projectId'], ['id', 'projectId'], {
  name: 'compile_jobs_snapshot_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('Blob', ['artifactBlobId', 'ownerId'], ['id', 'ownerId'], {
  name: 'compile_jobs_artifact_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class CompileJob {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'compile_jobs_pkey',
  })
  id!: number;
  @Column({ name: 'project_id', type: 'integer' }) projectId!: number;
  @Column({ name: 'owner_id', type: 'integer' }) ownerId!: number;
  @Column({ name: 'revision_id', type: 'integer' }) revisionId!: number;
  @Column({ name: 'snapshot_id', type: 'integer' }) snapshotId!: number;
  @Column({ name: 'input_manifest_hash', type: 'varchar', length: 64 }) inputManifestHash!: string;
  @Column({ type: 'varchar', length: 16, default: 'queued' }) status!: CompileStatus;
  @Column({ type: 'integer', default: 0 }) attempts!: number;
  @Column({ name: 'available_at', type: 'timestamptz', default: () => 'now()' }) availableAt!: Date;
  @Column({ name: 'lease_token', type: 'uuid', nullable: true, select: false }) leaseToken!:
    string | null;
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;
  @Column({ name: 'compiler_fingerprint', type: 'varchar', length: 64, nullable: true })
  compilerFingerprint!: string | null;
  @Column({ name: 'error_code', type: 'varchar', length: 32, nullable: true })
  errorCode!: CompileErrorCode | null;
  @Column({ type: 'jsonb', default: [] }) diagnostics!: CompileDiagnostic[];
  @Column({ name: 'artifact_blob_id', type: 'integer', nullable: true, select: false })
  artifactBlobId!: number | null;
  @Column({ name: 'artifact_expires_at', type: 'timestamptz', nullable: true })
  artifactExpiresAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true }) startedAt!: Date | null;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt!: Date | null;
}
