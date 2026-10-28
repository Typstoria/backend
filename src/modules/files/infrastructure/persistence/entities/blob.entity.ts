import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'blobs' })
@Unique('blobs_owner_hash_key', ['ownerId', 'sha256'])
@Unique('blobs_id_owner_key', ['id', 'ownerId'])
@Check('blobs_size_check', '"size_bytes" >= 0')
@ForeignKey('User', ['ownerId'], ['id'], { name: 'blobs_owner_fkey', onDelete: 'CASCADE' })
export class Blob {
  @PrimaryGeneratedColumn('increment', { type: 'integer', primaryKeyConstraintName: 'blobs_pkey' })
  id!: number;

  @Column({ name: 'owner_id', type: 'integer' })
  ownerId!: number;

  @Column({ name: 'storage_key', type: 'varchar', length: 128, select: false })
  storageKey!: string;

  @Column({ type: 'varchar', length: 64 })
  sha256!: string;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  @Column({ name: 'media_type', type: 'varchar', length: 100 })
  mediaType!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
