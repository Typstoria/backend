import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity({ name: 'web_sessions' })
@Index('web_sessions_user_id_idx', ['userId'])
@Index('web_sessions_expires_at_idx', ['expiresAt'])
export class WebSession {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'web_sessions_pkey',
  })
  id!: number;

  @Column({ name: 'user_id', type: 'integer' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'web_sessions_user_id_fkey' })
  user!: User;

  @Column({ name: 'secret_hash', type: 'varchar', length: 64, select: false })
  secretHash!: string;

  @Column({ name: 'auth_version', type: 'integer' })
  authVersion!: number;

  @Column({ name: 'user_agent', type: 'varchar', length: 256, default: '' })
  userAgent!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
