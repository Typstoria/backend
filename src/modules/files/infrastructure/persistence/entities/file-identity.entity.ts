import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'file_identities' })
@Unique('file_identities_id_project_key', ['id', 'projectId'])
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'file_identities_project_fkey',
  onDelete: 'CASCADE',
})
export class FileIdentity {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'file_identities_pkey',
  })
  id!: number;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
