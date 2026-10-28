import { Check, Column, CreateDateColumn, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type { HistoryErrorCode, HistorySyncStatus } from '../../../domain/git-history';

@Entity({ name: 'git_revision_mappings' })
@Index('git_revision_mappings_pending_idx', ['status', 'availableAt'])
@Index('git_revision_mappings_project_idx', ['projectId', 'revisionId'])
@Check('git_revision_mappings_status_check', `"status" IN ('pending', 'ready', 'failed')`)
@Check('git_revision_mappings_attempts_check', '"attempts" >= 0 AND "attempts" <= 5')
@ForeignKey('ProjectRevision', ['revisionId', 'projectId'], ['id', 'projectId'], {
  name: 'git_revision_mappings_revision_fkey',
  onDelete: 'CASCADE',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'git_revision_mappings_project_fkey',
  onDelete: 'CASCADE',
})
export class GitRevisionMapping {
  @PrimaryColumn({
    name: 'revision_id',
    type: 'integer',
    primaryKeyConstraintName: 'git_revision_mappings_pkey',
  })
  revisionId!: number;
  @Column({ name: 'project_id', type: 'integer' }) projectId!: number;
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: HistorySyncStatus;
  @Column({ name: 'commit_sha', type: 'varchar', length: 40, nullable: true }) commitSha!:
    string | null;
  @Column({ name: 'parent_sha', type: 'varchar', length: 40, nullable: true }) parentSha!:
    string | null;
  @Column({ type: 'integer', default: 0 }) attempts!: number;
  @Column({ name: 'available_at', type: 'timestamptz', default: () => 'now()' }) availableAt!: Date;
  @Column({ name: 'lease_token', type: 'uuid', nullable: true, select: false }) leaseToken!:
    string | null;
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;
  @Column({ name: 'error_code', type: 'varchar', length: 32, nullable: true })
  errorCode!: HistoryErrorCode | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
