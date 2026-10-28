import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCompilations1792946400000 implements MigrationInterface {
  name = 'CreateCompilations1792946400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "compile_jobs" ("id" SERIAL NOT NULL, "project_id" integer NOT NULL, "owner_id" integer NOT NULL, "session_id" integer NOT NULL, "key" character varying(128) NOT NULL, "payload_hash" character varying(64) NOT NULL, "revision_id" integer NOT NULL, "snapshot_id" integer NOT NULL, "input_manifest_hash" character varying(64) NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'queued', "attempts" integer NOT NULL DEFAULT '0', "available_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lease_token" uuid, "lease_expires_at" TIMESTAMP WITH TIME ZONE, "compiler_fingerprint" character varying(64), "error_code" character varying(32), "diagnostics" jsonb NOT NULL DEFAULT '[]'::jsonb, "artifact_blob_id" integer, "artifact_expires_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "compile_jobs_session_project_key" UNIQUE ("session_id", "project_id", "key"), CONSTRAINT "compile_jobs_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 3), CONSTRAINT "compile_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')), CONSTRAINT "compile_jobs_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "compile_jobs_owner_status_idx" ON "compile_jobs"  ("owner_id", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "compile_jobs_dispatch_idx" ON "compile_jobs"  ("status", "available_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_artifact_fkey" FOREIGN KEY ("artifact_blob_id", "owner_id") REFERENCES "blobs"("id","owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_session_fkey" FOREIGN KEY ("session_id") REFERENCES "web_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_snapshot_fkey" FOREIGN KEY ("snapshot_id", "project_id") REFERENCES "project_snapshots"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_revision_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_project_fkey" FOREIGN KEY ("project_id", "owner_id") REFERENCES "projects"("id","owner_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ used: boolean }> = await queryRunner.query(
      `SELECT EXISTS(SELECT 1 FROM "compile_jobs") AS "used"`,
    );
    if (rows[0]?.used) throw new Error('Cannot revert compilation while compile jobs exist');
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_project_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_revision_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_snapshot_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_session_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_artifact_fkey"`,
    );
    await queryRunner.query(`DROP INDEX "compile_jobs_dispatch_idx"`);
    await queryRunner.query(`DROP INDEX "compile_jobs_owner_status_idx"`);
    await queryRunner.query(`DROP TABLE "compile_jobs"`);
  }
}
