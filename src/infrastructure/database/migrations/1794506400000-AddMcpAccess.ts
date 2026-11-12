import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMcpAccess1794506400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE TABLE "mcp_oauth_records" ("model" character varying(40) NOT NULL, "key_hash" character varying(64) NOT NULL, "payload" jsonb NOT NULL, "grant_id" character varying(128), "uid" character varying(128), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "mcp_oauth_records_pkey" PRIMARY KEY ("model", "key_hash"))',
    );
    await runner.query(
      'CREATE INDEX "mcp_oauth_records_uid_idx" ON "mcp_oauth_records"  ("model", "uid") ',
    );
    await runner.query(
      'CREATE INDEX "mcp_oauth_records_expiry_idx" ON "mcp_oauth_records"  ("expires_at") ',
    );
    await runner.query(
      'CREATE INDEX "mcp_oauth_records_grant_idx" ON "mcp_oauth_records"  ("model", "grant_id") ',
    );
    await runner.query(
      'CREATE TABLE "mcp_access_grants" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "auth_version" integer NOT NULL, "kind" character varying(8) NOT NULL, "name" character varying(100) NOT NULL, "scopes" character varying array NOT NULL, "project_ids" integer array NOT NULL, "secret_hash" character varying(64), "oauth_grant_id" character varying(128), "client_id" character varying(200), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "mcp_access_grants_oauth_key" UNIQUE ("oauth_grant_id"), CONSTRAINT "mcp_access_grants_kind_check" CHECK (("kind" = \'pat\' AND "secret_hash" IS NOT NULL AND "oauth_grant_id" IS NULL AND "client_id" IS NULL) OR ("kind" = \'oauth\' AND "secret_hash" IS NULL AND "oauth_grant_id" IS NOT NULL AND "client_id" IS NOT NULL)), CONSTRAINT "mcp_access_grants_pkey" PRIMARY KEY ("id"))',
    );
    await runner.query(
      'CREATE INDEX "mcp_access_grants_user_id_idx" ON "mcp_access_grants"  ("user_id", "id") ',
    );
    await runner.query(
      'ALTER TABLE "mcp_access_grants" ADD CONSTRAINT "mcp_access_grants_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const [row]: { used: boolean }[] = await runner.query(
      'SELECT EXISTS(SELECT 1 FROM mcp_access_grants) OR EXISTS(SELECT 1 FROM mcp_oauth_records) AS used',
    );
    if (row?.used) throw new Error('Cannot revert while MCP access records exist');
    await runner.query('DROP TABLE "mcp_oauth_records"');
    await runner.query('DROP TABLE "mcp_access_grants"');
  }
}
