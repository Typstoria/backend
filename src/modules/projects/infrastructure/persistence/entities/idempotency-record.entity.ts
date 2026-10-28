import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { ProjectMutationResult } from '../../../domain/project-mutation-result';

@Entity({ name: 'idempotency_records' })
@Unique('idempotency_records_session_operation_key', ['sessionId', 'operation', 'key'])
@ForeignKey('WebSession', ['sessionId'], ['id'], {
  name: 'idempotency_records_session_fkey',
  onDelete: 'CASCADE',
})
@ForeignKey('Project', ['projectId'], ['id'], {
  name: 'idempotency_records_project_fkey',
  onDelete: 'CASCADE',
})
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'idempotency_records_pkey',
  })
  id!: number;

  @Column({ name: 'session_id', type: 'integer' })
  sessionId!: number;

  @Column({ type: 'varchar', length: 64 })
  operation!: string;

  @Column({ type: 'varchar', length: 128 })
  key!: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  @Column({ name: 'project_id', type: 'integer' })
  projectId!: number;

  @Column({ type: 'jsonb' })
  result!: ProjectMutationResult;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
