import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'project_revisions' })
@Unique('project_revisions_project_number_key', ['projectId', 'number'])
@Unique('project_revisions_id_project_key', ['id', 'projectId'])
@Check('project_revisions_number_check', '"number" >= 1')
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'project_revisions_project_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('ProjectSnapshot', ['snapshotId', 'projectId'], ['id', 'projectId'], {
  name: 'project_revisions_snapshot_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('ProjectRevision', ['parentRevisionId', 'projectId'], ['id', 'projectId'], {
  name: 'project_revisions_parent_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('User', ['actorId'], ['id'], {
  name: 'project_revisions_actor_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class ProjectRevision {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'project_revisions_pkey',
  })
  id!: number;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @Column({ type: 'integer' })
  number!: number;

  @Column({ name: 'parent_revision_id', type: 'integer', nullable: true })
  parentRevisionId!: number | null;

  @Column({ name: 'snapshot_id', type: 'integer' })
  snapshotId!: number;

  @Column({ name: 'actor_id', type: 'integer' })
  actorId!: number;

  @Column({ type: 'varchar', length: 16 })
  channel!: 'web' | 'mcp';

  @Column({ type: 'varchar', length: 32 })
  operation!: string;

  @Column({ type: 'varchar', length: 500 })
  summary!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
