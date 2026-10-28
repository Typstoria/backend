import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Preserve projects, uploads, jobs and history; retire delivery/replay bookkeeping. */
export class SimplifyBackgroundWork1793119200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "outbox_events"');
    await runner.query(`ALTER TABLE "compile_jobs"
      DROP COLUMN "session_id", DROP COLUMN "key", DROP COLUMN "payload_hash"`);
    await runner.query(`ALTER TABLE "staged_uploads"
      DROP COLUMN "session_id", DROP COLUMN "key", DROP COLUMN "payload_hash", DROP COLUMN "attached_revision_id"`);
    await runner.query(
      'CREATE INDEX "staged_uploads_owner_expiry_idx" ON "staged_uploads" ("owner_id", "expires_at")',
    );
    await runner.query('ALTER TABLE "projects" DROP COLUMN "metadata_version"');
    await runner.query(
      'ALTER TABLE "projects" ADD CONSTRAINT "projects_versions_check" CHECK ("next_revision_number" >= 2)',
    );
  }

  async down(): Promise<void> {
    throw new Error(
      'Retired session/replay metadata cannot be reconstructed. Restore a database backup to roll back this migration.',
    );
  }
}
