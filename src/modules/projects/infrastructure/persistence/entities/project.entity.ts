import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'projects' })
@Unique('projects_id_owner_key', ['id', 'ownerId'])
@Index('projects_owner_deleted_updated_idx', ['ownerId', 'deletedAt', 'updatedAt'])
@Check('projects_versions_check', '"next_revision_number" >= 2')
@ForeignKey('User', ['ownerId'], ['id'], { name: 'projects_owner_fkey', onDelete: 'CASCADE' })
@ForeignKey('ProjectRevision', ['currentRevisionId', 'id'], ['id', 'projectId'], {
  name: 'projects_current_revision_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class Project {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'projects_pkey',
  })
  id!: number;

  @Column({ name: 'owner_id', type: 'integer' })
  ownerId!: number;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ name: 'current_revision_id', type: 'integer' })
  currentRevisionId!: number;

  @Column({ name: 'next_revision_number', type: 'integer', default: 2 })
  nextRevisionNumber!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
