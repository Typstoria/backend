import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import database from '../../src/infrastructure/database/data-source';
import { CreateProjects1792763555247 } from '../../src/infrastructure/database/migrations/1792763555247-CreateProjects';
import { GeneralizeProjectIdempotency1792771200000 } from '../../src/infrastructure/database/migrations/1792771200000-GeneralizeProjectIdempotency';
import { AddResourceUploads1792860000000 } from '../../src/infrastructure/database/migrations/1792860000000-AddResourceUploads';
import { CreateCompilations1792946400000 } from '../../src/infrastructure/database/migrations/1792946400000-CreateCompilations';
import { CreateGitHistory1793032800000 } from '../../src/infrastructure/database/migrations/1793032800000-CreateGitHistory';

describe('project idempotency migration with existing results', () => {
  beforeAll(async () => {
    await database.initialize();
  });
  afterAll(async () => {
    if (database.isInitialized) await database.destroy();
  });

  it('preserves old create keys/results, supports rollback, and refuses to discard saved operation keys', async () => {
    const runner = database.createQueryRunner();
    const schema = `idempotency_${randomUUID().replaceAll('-', '')}`;
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      await runner.query(`CREATE TABLE "users" ("id" integer PRIMARY KEY)`);
      await runner.query(`CREATE TABLE "web_sessions" ("id" integer PRIMARY KEY)`);
      await runner.query(`INSERT INTO "users" VALUES (1)`);
      await runner.query(`INSERT INTO "web_sessions" VALUES (1)`);
      await new CreateProjects1792763555247().up(runner);
      await runner.query(
        `INSERT INTO "projects" ("id", "owner_id", "title", "current_revision_id") VALUES (1, 1, 'Original', 1)`,
      );
      await runner.query(`INSERT INTO "file_identities" ("id", "project_id") VALUES (1, 1)`);
      await runner.query(
        `INSERT INTO "blobs" ("id", "owner_id", "storage_key", "sha256", "size_bytes", "media_type") VALUES (1, 1, 'private', $1, 0, 'text/plain')`,
        ['a'.repeat(64)],
      );
      await runner.query(
        `INSERT INTO "project_snapshots" ("id", "project_id", "main_file_id", "manifest_hash") VALUES (1, 1, 1, $1)`,
        ['b'.repeat(64)],
      );
      await runner.query(
        `INSERT INTO "snapshot_files" ("snapshot_id", "file_id", "project_id", "owner_id", "normalized_path", "blob_id", "content_kind") VALUES (1, 1, 1, 1, 'main.typ', 1, 'text')`,
      );
      await runner.query(
        `INSERT INTO "project_revisions" ("id", "project_id", "number", "snapshot_id", "actor_id", "channel", "operation", "summary") VALUES (1, 1, 1, 1, 1, 'web', 'create', 'Created project')`,
      );
      await runner.query(
        `INSERT INTO "project_creations" ("session_id", "key", "payload_hash", "project_id") VALUES (1, 'existing-key', $1, 1)`,
        ['c'.repeat(64)],
      );
      const migration = new GeneralizeProjectIdempotency1792771200000();
      await migration.up(runner);
      const records: Array<{
        operation: string;
        key: string;
        payload_hash: string;
        result: object;
      }> = await runner.query(`SELECT * FROM "idempotency_records"`);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: 'projects.create',
        key: 'existing-key',
        payload_hash: 'c'.repeat(64),
        result: {
          projectId: 1,
          revisionId: 1,
          revisionNumber: 1,
          mainFileId: 1,
          manifestHash: 'b'.repeat(64),
          historySyncStatus: 'pending',
        },
      });
      await migration.down(runner);
      expect(await runner.hasTable(`${schema}.project_creations`)).toBe(true);
      expect(await runner.query(`SELECT "key" FROM "project_creations"`)).toEqual([
        { key: 'existing-key' },
      ]);
      await migration.up(runner);
      await runner.query(
        `INSERT INTO "idempotency_records" ("session_id", "operation", "key", "payload_hash", "project_id", "result") VALUES (1, 'projects:1:changes', 'existing-key', $1, 1, $2::jsonb)`,
        ['d'.repeat(64), JSON.stringify(records[0]!.result)],
      );
      await expect(migration.down(runner)).rejects.toThrow('completed non-create operations');
      expect(
        await runner.query(`SELECT "operation" FROM "idempotency_records" ORDER BY "id"`),
      ).toEqual([{ operation: 'projects.create' }, { operation: 'projects:1:changes' }]);
      const resources = new AddResourceUploads1792860000000();
      // Flush deferred FK events from the seeded graph before altering those tables.
      await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await resources.up(runner);
      expect(await runner.query(`SELECT "media_type" FROM "snapshot_files"`)).toEqual([
        { media_type: 'text/plain' },
      ]);
      await resources.down(runner);
      expect(await runner.hasColumn(`${schema}.snapshot_files`, 'media_type')).toBe(false);
      await resources.up(runner);
      await runner.query(
        `INSERT INTO "staged_uploads" ("project_id", "owner_id", "session_id", "key", "payload_hash", "blob_id", "filename", "media_type", "expires_at") VALUES (1, 1, 1, 'upload-key', $1, 1, 'logo.png', 'image/png', now() + interval '1 day')`,
        ['e'.repeat(64)],
      );
      await expect(resources.down(runner)).rejects.toThrow('upload records');
      await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
      const compilations = new CreateCompilations1792946400000();
      await compilations.up(runner);
      await compilations.down(runner);
      expect(await runner.hasTable(`${schema}.compile_jobs`)).toBe(false);
      await compilations.up(runner);
      await runner.query(
        `INSERT INTO "compile_jobs" ("project_id", "owner_id", "session_id", "key", "payload_hash", "revision_id", "snapshot_id", "input_manifest_hash") VALUES (1, 1, 1, 'compile-key', $1, 1, 1, $1)`,
        ['f'.repeat(64)],
      );
      await expect(compilations.down(runner)).rejects.toThrow('compile jobs exist');
      const history = new CreateGitHistory1793032800000();
      await history.up(runner);
      expect(
        await runner.query(
          `SELECT "revision_id", "status" FROM "git_revision_mappings" ORDER BY "revision_id"`,
        ),
      ).toEqual([{ revision_id: 1, status: 'pending' }]);
      await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await history.down(runner);
      await history.up(runner);
      await runner.query(`UPDATE "git_revision_mappings" SET "status" = 'failed', "attempts" = 1`);
      await expect(history.down(runner)).rejects.toThrow('projection attempts');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
