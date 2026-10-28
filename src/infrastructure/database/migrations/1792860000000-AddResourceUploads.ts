import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResourceUploads1792860000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "snapshot_files" ADD "media_type" varchar(100)`);
    await runner.query(
      `UPDATE "snapshot_files" AS file SET "media_type" = blob."media_type" FROM "blobs" AS blob WHERE blob."id" = file."blob_id"`,
    );
    await runner.query(`ALTER TABLE "snapshot_files" ALTER COLUMN "media_type" SET NOT NULL`);
    await runner.query(`CREATE TABLE "staged_uploads" (
      "id" SERIAL NOT NULL, "project_id" integer NOT NULL, "owner_id" integer NOT NULL,
      "session_id" integer NOT NULL, "key" varchar(128) NOT NULL, "payload_hash" varchar(64) NOT NULL,
      "blob_id" integer NOT NULL, "filename" varchar(255) NOT NULL, "media_type" varchar(100) NOT NULL,
      "attached_revision_id" integer, "expires_at" timestamptz NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "staged_uploads_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "staged_uploads_session_project_key" UNIQUE ("session_id", "project_id", "key"),
      CONSTRAINT "staged_uploads_project_fkey" FOREIGN KEY ("project_id", "owner_id") REFERENCES "projects"("id", "owner_id") ON DELETE CASCADE,
      CONSTRAINT "staged_uploads_blob_fkey" FOREIGN KEY ("blob_id", "owner_id") REFERENCES "blobs"("id", "owner_id") DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT "staged_uploads_session_fkey" FOREIGN KEY ("session_id") REFERENCES "web_sessions"("id") ON DELETE CASCADE,
      CONSTRAINT "staged_uploads_revision_fkey" FOREIGN KEY ("attached_revision_id", "project_id") REFERENCES "project_revisions"("id", "project_id") DEFERRABLE INITIALLY DEFERRED
    )`);
    await runner.query(
      `CREATE INDEX "staged_uploads_project_expiry_idx" ON "staged_uploads" ("project_id", "attached_revision_id", "expires_at")`,
    );
    await runner.query(
      `CREATE INDEX "staged_uploads_owner_expiry_idx" ON "staged_uploads" ("owner_id", "attached_revision_id", "expires_at")`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const rows: Array<{ used: boolean }> =
      await runner.query(`SELECT EXISTS(SELECT 1 FROM "staged_uploads") OR EXISTS(
      SELECT 1 FROM "snapshot_files" file JOIN "blobs" blob ON blob."id" = file."blob_id"
      WHERE file."content_kind" = 'binary' OR file."media_type" <> blob."media_type") AS "used"`);
    if (rows[0]?.used)
      throw new Error(
        'Cannot revert resource uploads while upload records or resource-specific snapshot metadata exist',
      );
    await runner.query(`DROP TABLE "staged_uploads"`);
    await runner.query(`ALTER TABLE "snapshot_files" DROP COLUMN "media_type"`);
  }
}
