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
@ForeignKey('Blob', ['previewBlobId', 'ownerId'], ['id', 'ownerId'], {
  name: 'projects_preview_blob_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('ProjectRevision', ['previewRevisionId', 'id'], ['id', 'projectId'], {
  name: 'projects_preview_revision_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@Check(
  'projects_preview_check',
  '("preview_blob_id" IS NULL AND "preview_revision_id" IS NULL AND "preview_version" IS NULL AND "preview_job_id" IS NULL) OR ("preview_blob_id" IS NOT NULL AND "preview_revision_id" IS NOT NULL AND "preview_version" IS NOT NULL AND "preview_job_id" IS NOT NULL)',
)
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

  @Column({ name: 'preview_blob_id', type: 'integer', nullable: true, select: false })
  previewBlobId!: number | null;

  @Column({ name: 'preview_revision_id', type: 'integer', nullable: true })
  previewRevisionId!: number | null;

  @Column({ name: 'preview_job_id', type: 'integer', nullable: true, select: false })
  previewJobId!: number | null;

  @Column({ name: 'preview_version', type: 'varchar', length: 64, nullable: true })
  previewVersion!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
