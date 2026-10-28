import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GeneralizeProjectIdempotency1792771200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "project_creations" RENAME TO "idempotency_records"`);
    await runner.query(
      `ALTER SEQUENCE "project_creations_id_seq" RENAME TO "idempotency_records_id_seq"`,
    );
    await runner.query(
      `ALTER TABLE "idempotency_records" RENAME CONSTRAINT "project_creations_pkey" TO "idempotency_records_pkey"`,
    );
    await runner.query(
      `ALTER TABLE "idempotency_records" RENAME CONSTRAINT "project_creations_session_fkey" TO "idempotency_records_session_fkey"`,
    );
    await runner.query(
      `ALTER TABLE "idempotency_records" RENAME CONSTRAINT "project_creations_project_fkey" TO "idempotency_records_project_fkey"`,
    );
    await runner.query(
      `ALTER TABLE "idempotency_records" ADD "operation" varchar(64) NOT NULL DEFAULT 'projects.create', ADD "result" jsonb`,
    );
    await runner.query(`UPDATE "idempotency_records" AS record SET "result" = jsonb_build_object(
      'projectId', record."project_id", 'revisionId', revision."id", 'revisionNumber', revision."number",
      'mainFileId', snapshot."main_file_id", 'manifestHash', snapshot."manifest_hash", 'historySyncStatus', 'pending'
    ) FROM "project_revisions" AS revision JOIN "project_snapshots" AS snapshot ON snapshot."id" = revision."snapshot_id"
    WHERE revision."project_id" = record."project_id" AND revision."number" = 1`);
    await runner.query(
      `ALTER TABLE "idempotency_records" ALTER COLUMN "result" SET NOT NULL, ALTER COLUMN "operation" DROP DEFAULT`,
    );
    await runner.query(`ALTER TABLE "idempotency_records" DROP CONSTRAINT "project_creations_session_key",
      ADD CONSTRAINT "idempotency_records_session_operation_key" UNIQUE ("session_id", "operation", "key")`);
  }

  async down(runner: QueryRunner): Promise<void> {
    const rows: Array<{ used: boolean }> = await runner.query(
      `SELECT EXISTS(SELECT 1 FROM "idempotency_records" WHERE "operation" <> 'projects.create') AS "used"`,
    );
    if (rows[0]?.used)
      throw new Error('Cannot revert idempotency while completed non-create operations exist');
    await runner.query(`ALTER TABLE "idempotency_records" DROP CONSTRAINT "idempotency_records_session_operation_key",
      ADD CONSTRAINT "project_creations_session_key" UNIQUE ("session_id", "key"), DROP COLUMN "operation", DROP COLUMN "result"`);
    await runner.query(
      `ALTER TABLE "idempotency_records" RENAME CONSTRAINT "idempotency_records_project_fkey" TO "project_creations_project_fkey"`,
    );
    await runner.query(
      `ALTER TABLE "idempotency_records" RENAME CONSTRAINT "idempotency_records_session_fkey" TO "project_creations_session_fkey"`,
    );
    await runner.query(
      `ALTER TABLE "idempotency_records" RENAME CONSTRAINT "idempotency_records_pkey" TO "project_creations_pkey"`,
    );
    await runner.query(
      `ALTER SEQUENCE "idempotency_records_id_seq" RENAME TO "project_creations_id_seq"`,
    );
    await runner.query(`ALTER TABLE "idempotency_records" RENAME TO "project_creations"`);
  }
}
