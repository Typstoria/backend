import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIdentitySessions1792326000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "auth_version" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(
      `CREATE TYPE "identity_challenge_kind" AS ENUM ('verify_email', 'reset_password')`,
    );
    await queryRunner.query(`CREATE TABLE "web_sessions" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL,
      "secret_hash" varchar(64) NOT NULL, "auth_version" integer NOT NULL,
      "user_agent" varchar(256) NOT NULL DEFAULT '', "created_at" timestamptz NOT NULL DEFAULT now(),
      "expires_at" timestamptz NOT NULL, "revoked_at" timestamptz,
      CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "web_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(
      `CREATE INDEX "web_sessions_user_id_idx" ON "web_sessions" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "web_sessions_expires_at_idx" ON "web_sessions" ("expires_at")`,
    );
    await queryRunner.query(`CREATE TABLE "identity_challenges" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL,
      "kind" "identity_challenge_kind" NOT NULL, "token_hash" varchar(64) NOT NULL,
      "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "identity_challenges_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "identity_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "identity_challenges_token_hash_key" ON "identity_challenges" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "identity_challenges_user_kind_idx" ON "identity_challenges" ("user_id", "kind", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "identity_challenges_expires_at_idx" ON "identity_challenges" ("expires_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "identity_challenges"`);
    await queryRunner.query(`DROP TABLE "web_sessions"`);
    await queryRunner.query(`DROP TYPE "identity_challenge_kind"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "auth_version"`);
  }
}
