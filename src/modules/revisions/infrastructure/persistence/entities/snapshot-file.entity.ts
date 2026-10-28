import { Column, Entity, ForeignKey, PrimaryColumn, Unique } from 'typeorm';

@Entity({ name: 'snapshot_files' })
@Unique('snapshot_files_snapshot_path_key', ['snapshotId', 'normalizedPath'])
@ForeignKey('ProjectSnapshot', ['snapshotId', 'projectId'], ['id', 'projectId'], {
  name: 'snapshot_files_snapshot_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('FileIdentity', ['fileId', 'projectId'], ['id', 'projectId'], {
  name: 'snapshot_files_file_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('Project', ['projectId', 'ownerId'], ['id', 'ownerId'], {
  name: 'snapshot_files_owner_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
@ForeignKey('Blob', ['blobId', 'ownerId'], ['id', 'ownerId'], {
  name: 'snapshot_files_blob_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class SnapshotFile {
  @PrimaryColumn({
    name: 'snapshot_id',
    type: 'integer',
    primaryKeyConstraintName: 'snapshot_files_pkey',
  })
  snapshotId!: number;

  @PrimaryColumn({
    name: 'file_id',
    type: 'integer',
    primaryKeyConstraintName: 'snapshot_files_pkey',
  })
  fileId!: number;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @Column({ name: 'owner_id', type: 'integer' })
  ownerId!: number;

  @Column({ name: 'normalized_path', type: 'varchar', length: 1024 })
  normalizedPath!: string;

  @Column({ name: 'blob_id', type: 'integer' })
  blobId!: number;

  @Column({ name: 'content_kind', type: 'varchar', length: 16 })
  contentKind!: 'text' | 'binary';

  @Column({ name: 'media_type', type: 'varchar', length: 100 })
  mediaType!: string;
}
