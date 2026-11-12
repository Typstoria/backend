import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'proposals' })
@Unique('proposals_id_project_key', ['id', 'projectId'])
@Index('proposals_project_id_idx', ['projectId', 'id'])
@Check('proposals_status_check', `"status" IN ('draft', 'accepted', 'rejected')`)
@Check('proposals_version_check', '"version" >= 1 AND "version" <= 100')
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'proposals_project_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('User', ['creatorId'], ['id'], {
  name: 'proposals_creator_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('ProjectRevision', ['acceptedRevisionId', 'projectId'], ['id', 'projectId'], {
  name: 'proposals_accepted_revision_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class Proposal {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'proposals_pkey',
  })
  id!: number;
  @Column({ name: 'project_id', type: 'integer' }) projectId!: number;
  @Column({ name: 'creator_id', type: 'integer' }) creatorId!: number;
  @Column({ type: 'varchar', length: 16 }) channel!: 'web' | 'mcp';
  @Column({ type: 'varchar', length: 16, default: 'draft' }) status!:
    'draft' | 'accepted' | 'rejected';
  @Column({ type: 'integer', default: 1 }) version!: number;
  @Column({ name: 'accepted_revision_id', type: 'integer', nullable: true }) acceptedRevisionId!:
    number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
}
