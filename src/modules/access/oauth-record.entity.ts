import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('mcp_oauth_records')
@Index('mcp_oauth_records_grant_idx', ['model', 'grantId'])
@Index('mcp_oauth_records_expiry_idx', ['expiresAt'])
@Index('mcp_oauth_records_uid_idx', ['model', 'uid'])
export class OAuthRecord {
  @PrimaryColumn({
    type: 'varchar',
    length: 40,
    primaryKeyConstraintName: 'mcp_oauth_records_pkey',
  })
  model!: string;
  @PrimaryColumn({
    name: 'key_hash',
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'mcp_oauth_records_pkey',
  })
  keyHash!: string;
  @Column({ type: 'jsonb' }) payload!: object;
  @Column({ name: 'grant_id', type: 'varchar', length: 128, nullable: true }) grantId!:
    string | null;
  @Column({ type: 'varchar', length: 128, nullable: true }) uid!: string | null;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
}
