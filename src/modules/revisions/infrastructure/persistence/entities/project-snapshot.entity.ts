import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'project_snapshots' })
@Unique('project_snapshots_id_project_key', ['id', 'projectId'])
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'project_snapshots_project_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('SnapshotFile', ['id', 'mainFileId'], ['snapshotId', 'fileId'], {
  name: 'project_snapshots_main_file_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class ProjectSnapshot {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'project_snapshots_pkey',
  })
  id!: number;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @Column({ name: 'main_file_id', type: 'integer' })
  mainFileId!: number;

  @Column({ name: 'context_text', type: 'text', default: '' })
  contextText!: string;

  @Column({ name: 'manifest_hash', type: 'varchar', length: 64 })
  manifestHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
