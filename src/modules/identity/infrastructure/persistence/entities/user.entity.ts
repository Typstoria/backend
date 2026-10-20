import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'users' })
@Index('users_normalized_email_key', ['normalizedEmail'], { unique: true })
@Index('users_google_subject_key', ['googleSubject'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('increment', { type: 'integer', primaryKeyConstraintName: 'users_pkey' })
  id!: number;

  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ name: 'normalized_email', type: 'varchar', length: 254 })
  normalizedEmail!: string;

  @Column({ name: 'password_hash', type: 'text', select: false, nullable: true })
  passwordHash!: string | null;

  @Column({ name: 'google_subject', type: 'varchar', length: 255, nullable: true })
  googleSubject!: string | null;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({ name: 'auth_version', type: 'integer', default: 0 })
  authVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
