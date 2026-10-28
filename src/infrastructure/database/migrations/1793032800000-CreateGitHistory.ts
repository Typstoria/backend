import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGitHistory1793032800000 implements MigrationInterface {
  name = 'CreateGitHistory1793032800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "git_revision_mappings" ("revision_id" integer NOT NULL, "project_id" integer NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'pending', "commit_sha" character varying(40), "parent_sha" character varying(40), "attempts" integer NOT NULL DEFAULT '0', "available_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lease_token" uuid, "lease_expires_at" TIMESTAMP WITH TIME ZONE, "error_code" character varying(32), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "git_revision_mappings_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 5), CONSTRAINT "git_revision_mappings_status_check" CHECK ("status" IN ('pending', 'ready', 'failed')), CONSTRAINT "git_revision_mappings_pkey" PRIMARY KEY ("revision_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "git_revision_mappings_project_idx" ON "git_revision_mappings"  ("project_id", "revision_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "git_revision_mappings_pending_idx" ON "git_revision_mappings"  ("status", "available_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "git_revision_mappings" ADD CONSTRAINT "git_revision_mappings_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "git_revision_mappings" ADD CONSTRAINT "git_revision_mappings_revision_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `INSERT INTO "git_revision_mappings" ("revision_id", "project_id") SELECT "id", "project_id" FROM "project_revisions"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ used: boolean }> = await queryRunner.query(
      `SELECT EXISTS(SELECT 1 FROM "git_revision_mappings" WHERE "status" <> 'pending' OR "attempts" > 0 OR "commit_sha" IS NOT NULL) AS "used"`,
    );
    if (rows[0]?.used) throw new Error('Cannot revert Git history after projection attempts exist');
    await queryRunner.query(
      `ALTER TABLE "git_revision_mappings" DROP CONSTRAINT "git_revision_mappings_revision_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "git_revision_mappings" DROP CONSTRAINT "git_revision_mappings_project_fkey"`,
    );
    await queryRunner.query(`DROP INDEX "git_revision_mappings_pending_idx"`);
    await queryRunner.query(`DROP INDEX "git_revision_mappings_project_idx"`);
    await queryRunner.query(`DROP TABLE "git_revision_mappings"`);
  }
}
