import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { McpScope } from '../../common/actor/access-policy';

@Entity('mcp_access_grants')
@Index('mcp_access_grants_user_id_idx', ['userId', 'id'])
@Unique('mcp_access_grants_oauth_key', ['oauthGrantId'])
@Check(
  'mcp_access_grants_kind_check',
  `("kind" = 'pat' AND "secret_hash" IS NOT NULL AND "oauth_grant_id" IS NULL AND "client_id" IS NULL) OR ("kind" = 'oauth' AND "secret_hash" IS NULL AND "oauth_grant_id" IS NOT NULL AND "client_id" IS NOT NULL)`,
)
@ForeignKey('User', ['userId'], ['id'], {
  name: 'mcp_access_grants_user_fkey',
  onDelete: 'CASCADE',
})
export class AccessGrant {
  @PrimaryGeneratedColumn('increment', {
    type: 'integer',
    primaryKeyConstraintName: 'mcp_access_grants_pkey',
  })
  id!: number;
  @Column({ name: 'user_id', type: 'integer' }) userId!: number;
  @Column({ name: 'auth_version', type: 'integer' }) authVersion!: number;
  // Historical grants are retained for audit. Only OAuth grants are issued or authenticated.
  @Column({ type: 'varchar', length: 8 }) kind!: 'pat' | 'oauth';
  @Column({ type: 'varchar', length: 100 }) name!: string;
  @Column({ type: 'varchar', array: true }) scopes!: McpScope[];
  @Column({ name: 'project_ids', type: 'integer', array: true }) projectIds!: number[];
  @Column({ name: 'secret_hash', type: 'varchar', length: 64, nullable: true, select: false })
  secretHash!: string | null;
  @Column({ name: 'oauth_grant_id', type: 'varchar', length: 128, nullable: true }) oauthGrantId!:
    string | null;
  @Column({ name: 'client_id', type: 'varchar', length: 200, nullable: true }) clientId!:
    string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
}
