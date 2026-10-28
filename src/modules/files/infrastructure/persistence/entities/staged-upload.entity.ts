import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'staged_uploads' })
@Index('staged_uploads_owner_expiry_idx', ['ownerId', 'expiresAt'])
@ForeignKey('Project', ['projectId', 'ownerId'], ['id', 'ownerId'], {
  name: 'staged_uploads_project_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('Blob', ['blobId', 'ownerId'], ['id', 'ownerId'], {
  name: 'staged_uploads_blob_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class StagedUpload {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'staged_uploads_pkey',
  })
  id!: number;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @Column({ name: 'owner_id', type: 'integer' })
  ownerId!: number;

  @Column({ name: 'blob_id', type: 'integer' })
  blobId!: number;

  @Column({ type: 'varchar', length: 255 })
  filename!: string;

  @Column({ name: 'media_type', type: 'varchar', length: 100 })
  mediaType!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
