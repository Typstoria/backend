import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'audit_events' })
@Index('audit_events_project_created_idx', ['projectId', 'createdAt'])
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'audit_events_project_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('User', ['actorId'], ['id'], {
  name: 'audit_events_actor_fkey',
  deferrable: 'INITIALLY DEFERRED',
})
export class AuditEvent {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'audit_events_pkey',
  })
  id!: number;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @Column({ name: 'actor_id', type: 'integer' })
  actorId!: number;

  @Column({ name: 'credential_id', type: 'integer' })
  credentialId!: number;

  @Column({ type: 'varchar', length: 16 })
  channel!: 'web' | 'mcp';

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ name: 'request_id', type: 'varchar', length: 128 })
  requestId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
