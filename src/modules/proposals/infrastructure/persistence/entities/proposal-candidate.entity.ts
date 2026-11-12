import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { TextChange } from '../../../../projects/domain/text-changes';

@Entity({ name: 'proposal_candidates' })
@Unique('proposal_candidates_version_key', ['proposalId', 'version'])
@Unique('proposal_candidates_target_key', ['proposalId', 'version', 'projectId', 'snapshotId'])
@Check('proposal_candidates_version_check', '"version" >= 1 AND "version" <= 100')
@ForeignKey('Proposal', ['proposalId', 'projectId'], ['id', 'projectId'], {
  name: 'proposal_candidates_proposal_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('ProjectRevision', ['baseRevisionId', 'projectId'], ['id', 'projectId'], {
  name: 'proposal_candidates_base_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('ProjectSnapshot', ['snapshotId', 'projectId'], ['id', 'projectId'], {
  name: 'proposal_candidates_snapshot_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class ProposalCandidate {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'proposal_candidates_pkey',
  })
  id!: number;
  @Column({ name: 'proposal_id', type: 'integer' }) proposalId!: number;
  @Column({ name: 'project_id', type: 'integer' }) projectId!: number;
  @Column({ type: 'integer' }) version!: number;
  @Column({ name: 'base_revision_id', type: 'integer' }) baseRevisionId!: number;
  @Column({ name: 'snapshot_id', type: 'integer' }) snapshotId!: number;
  @Column({ type: 'varchar', length: 500 }) summary!: string;
  @Column({ type: 'jsonb', select: false }) operations!: TextChange[];
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
