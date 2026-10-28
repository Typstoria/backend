import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/infrastructure/database/database.options';
import { validateDatabaseEnvironment } from '../../src/config/environment';
import { SimplifyBackgroundWork1793119200000 } from '../../src/infrastructure/database/migrations/1793119200000-SimplifyBackgroundWork';
import { CreateUsers1792270800000 } from '../../src/infrastructure/database/migrations/1792270800000-CreateUsers';
import { AddIdentitySessions1792326000000 } from '../../src/infrastructure/database/migrations/1792326000000-AddIdentitySessions';
import { UseNumericIdentityIds1792330200000 } from '../../src/infrastructure/database/migrations/1792330200000-UseNumericIdentityIds';
import { RemoveUserStatus1792488600000 } from '../../src/infrastructure/database/migrations/1792488600000-RemoveUserStatus';
import { AddGoogleSignIn1792494000000 } from '../../src/infrastructure/database/migrations/1792494000000-AddGoogleSignIn';
import { CreateProjects1792763555247 } from '../../src/infrastructure/database/migrations/1792763555247-CreateProjects';
import { GeneralizeProjectIdempotency1792771200000 } from '../../src/infrastructure/database/migrations/1792771200000-GeneralizeProjectIdempotency';
import { AddResourceUploads1792860000000 } from '../../src/infrastructure/database/migrations/1792860000000-AddResourceUploads';
import { CreateCompilations1792946400000 } from '../../src/infrastructure/database/migrations/1792946400000-CreateCompilations';
import { CreateGitHistory1793032800000 } from '../../src/infrastructure/database/migrations/1793032800000-CreateGitHistory';

it('migrates populated legacy projects, reusable uploads and pending jobs without losing content', async () => {
  const schema = `simplification_${randomUUID().replaceAll('-', '')}`;
  const options = createDatabaseOptions(validateDatabaseEnvironment(process.env));
  const admin = await new DataSource({ ...options, migrations: [] }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = new DataSource({
    ...options,
    schema,
    extra: { ...options.extra, options: `-c search_path=${schema}` },
    migrations: [
      CreateUsers1792270800000,
      AddIdentitySessions1792326000000,
      UseNumericIdentityIds1792330200000,
      RemoveUserStatus1792488600000,
      AddGoogleSignIn1792494000000,
      CreateProjects1792763555247,
      GeneralizeProjectIdempotency1792771200000,
      AddResourceUploads1792860000000,
      CreateCompilations1792946400000,
      CreateGitHistory1793032800000,
    ],
  });
  try {
    await database.initialize();
    await database.runMigrations();
    const id = async (sql: string, values: unknown[] = []): Promise<number> => {
      const rows: { id: number }[] = await database.query(sql, values);
      return rows[0]!.id;
    };
    const user = await id(
      `INSERT INTO users (email, normalized_email, email_verified_at) VALUES ('migration@example.test','migration@example.test', now()) RETURNING id`,
    );
    const session = await id(
      `INSERT INTO web_sessions (user_id, secret_hash, auth_version, expires_at) VALUES ($1, $2, 0, now() + interval '1 day') RETURNING id`,
      [user, 'a'.repeat(64)],
    );
    await database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO projects (id, owner_id, title, current_revision_id) VALUES (1, $1, 'Preserved', 1)`,
        [user],
      );
      await manager.query(`INSERT INTO file_identities (id, project_id) VALUES (1,1)`);
      await manager.query(
        `INSERT INTO project_snapshots (id, project_id, main_file_id, manifest_hash) VALUES (1,1,1,$1)`,
        ['b'.repeat(64)],
      );
      await manager.query(
        `INSERT INTO blobs (id, owner_id, storage_key, sha256, size_bytes, media_type) VALUES (1,$1,$2,$3,8,'text/plain')`,
        [user, `${user}/${'c'.repeat(64)}`, 'c'.repeat(64)],
      );
      await manager.query(
        `INSERT INTO snapshot_files (snapshot_id, file_id, project_id, owner_id, normalized_path, blob_id, content_kind, media_type) VALUES (1,1,1,$1,'main.typ',1,'text','text/plain')`,
        [user],
      );
      await manager.query(
        `INSERT INTO project_revisions (id, project_id, number, snapshot_id, actor_id, channel, operation, summary) VALUES (1,1,1,1,$1,'web','create','Created')`,
        [user],
      );
      await manager.query(
        `INSERT INTO git_revision_mappings (revision_id, project_id) VALUES (1,1)`,
      );
      await manager.query(
        `INSERT INTO compile_jobs (id, project_id, owner_id, session_id, key, payload_hash, revision_id, snapshot_id, input_manifest_hash) VALUES (1,1,$1,$2,'legacy',$3,1,1,$3)`,
        [user, session, 'b'.repeat(64)],
      );
      await manager.query(
        `INSERT INTO staged_uploads (id, project_id, owner_id, session_id, key, payload_hash, blob_id, filename, media_type, attached_revision_id, expires_at) VALUES (1,1,$1,$2,'legacy',$3,1,'source.txt','text/plain',1,now()+interval '1 day')`,
        [user, session, 'b'.repeat(64)],
      );
      await manager.query(
        `INSERT INTO outbox_events (event_id, project_id, kind, payload) VALUES ($1,1,'compile.requested','{"jobId":1}')`,
        [randomUUID()],
      );
    });
    const runner = database.createQueryRunner();
    try {
      await runner.startTransaction();
      await new SimplifyBackgroundWork1793119200000().up(runner);
      await runner.commitTransaction();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    expect(await database.query('SELECT title, current_revision_id FROM projects')).toEqual([
      { title: 'Preserved', current_revision_id: 1 },
    ]);
    expect(await database.query('SELECT status, revision_id FROM compile_jobs')).toEqual([
      { status: 'queued', revision_id: 1 },
    ]);
    expect(await database.query('SELECT id, blob_id FROM staged_uploads')).toEqual([
      { id: 1, blob_id: 1 },
    ]);
    expect(await database.query('SELECT normalized_path, blob_id FROM snapshot_files')).toEqual([
      { normalized_path: 'main.typ', blob_id: 1 },
    ]);
    await database.query('DELETE FROM web_sessions WHERE id = $1', [session]);
    expect(await database.query('SELECT id FROM compile_jobs')).toHaveLength(1);
    expect(await database.query('SELECT id FROM staged_uploads')).toHaveLength(1);
    const pending = await database.query('SELECT revision_id, status FROM git_revision_mappings');
    expect(pending).toEqual([{ revision_id: 1, status: 'pending' }]);
  } finally {
    if (database.isInitialized) await database.destroy();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
  }
});
