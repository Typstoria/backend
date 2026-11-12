import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'proposal_validations' })
@Index('proposal_validations_candidate_idx', ['proposalId', 'candidateVersion', 'id'])
@ForeignKey(
  'ProposalCandidate',
  ['proposalId', 'candidateVersion', 'projectId', 'snapshotId'],
  ['proposalId', 'version', 'projectId', 'snapshotId'],
  {
    name: 'proposal_validations_candidate_fkey',
    onDelete: 'CASCADE',
    deferrable: 'INITIALLY DEFERRED',
  },
)
@ForeignKey('CompileJob', ['compileJobId'], ['id'], {
  name: 'proposal_validations_job_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class ProposalValidation {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'proposal_validations_pkey',
  })
  id!: number;
  @Column({ name: 'proposal_id', type: 'integer' }) proposalId!: number;
  @Column({ name: 'project_id', type: 'integer' }) projectId!: number;
  @Column({ name: 'candidate_version', type: 'integer' }) candidateVersion!: number;
  @Column({ name: 'snapshot_id', type: 'integer' }) snapshotId!: number;
  @Column({ name: 'compile_job_id', type: 'integer', nullable: true }) compileJobId!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
