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

export enum ChallengeKind {
  VerifyEmail = 'verify_email',
  ResetPassword = 'reset_password',
}

@Entity({ name: 'identity_challenges' })
@Index('identity_challenges_token_hash_key', ['tokenHash'], { unique: true })
@Index('identity_challenges_user_kind_idx', ['userId', 'kind', 'createdAt'])
@Index('identity_challenges_expires_at_idx', ['expiresAt'])
export class IdentityChallenge {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'identity_challenges_pkey',
  })
  id!: number;

  @Column({ name: 'user_id', type: 'integer' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'identity_challenges_user_id_fkey' })
  user!: User;

  @Column({ type: 'enum', enum: ChallengeKind, enumName: 'identity_challenge_kind' })
  kind!: ChallengeKind;

  @Column({ name: 'token_hash', type: 'varchar', length: 64, select: false })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
