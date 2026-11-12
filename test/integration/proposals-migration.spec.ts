import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/infrastructure/database/database.options';
import { validateDatabaseEnvironment } from '../../src/config/environment';

it('migrates accepted jobs without losing data and supports reverting unused proposals', async () => {
  const schema = `proposals_${randomUUID().replaceAll('-', '')}`;
  const options = createDatabaseOptions(validateDatabaseEnvironment(process.env));
  const admin = await new DataSource({ ...options, migrations: [] }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = new DataSource({
    ...options,
    schema,
    extra: { ...options.extra, options: `-c search_path=${schema}` },
  });
  try {
    await database.initialize();
    await database.runMigrations();
    await database.undoLastMigration(); // MCP access
    await database.undoLastMigration(); // proposals
    expect(await database.query("SELECT to_regclass('proposals') AS name")).toEqual([
      { name: null },
    ]);
    const users: { id: number }[] = await database.query(
      "INSERT INTO users (email, normalized_email, email_verified_at) VALUES ('legacy@example.test','legacy@example.test',now()) RETURNING id",
    );
    await database.transaction(async (manager) => {
      await manager.query(
        "INSERT INTO projects (id, owner_id, title, current_revision_id) VALUES (1,$1,'Legacy',1)",
        [users[0]!.id],
      );
      await manager.query('INSERT INTO file_identities (id, project_id) VALUES (1,1)');
      await manager.query(
        'INSERT INTO project_snapshots (id, project_id, main_file_id, manifest_hash) VALUES (1,1,1,$1)',
        ['b'.repeat(64)],
      );
      await manager.query(
        "INSERT INTO blobs (id, owner_id, storage_key, sha256, size_bytes, media_type) VALUES (1,$1,'legacy',$2,0,'text/plain')",
        [users[0]!.id, 'c'.repeat(64)],
      );
      await manager.query(
        "INSERT INTO snapshot_files (snapshot_id,file_id,project_id,owner_id,normalized_path,blob_id,content_kind,media_type) VALUES (1,1,1,$1,'main.typ',1,'text','text/plain')",
        [users[0]!.id],
      );
      await manager.query(
        "INSERT INTO project_revisions (id,project_id,number,snapshot_id,actor_id,channel,operation,summary) VALUES (1,1,1,1,$1,'web','create','Created')",
        [users[0]!.id],
      );
      await manager.query(
        'INSERT INTO compile_jobs (id,project_id,owner_id,revision_id,snapshot_id,input_manifest_hash) VALUES (1,1,$1,1,1,$2)',
        [users[0]!.id, 'b'.repeat(64)],
      );
    });
    await database.runMigrations();
    expect(
      await database.query(
        'SELECT revision_id,proposal_id,candidate_version,status FROM compile_jobs',
      ),
    ).toEqual([{ revision_id: 1, proposal_id: null, candidate_version: null, status: 'queued' }]);
    await expect(
      database.query('UPDATE compile_jobs SET revision_id=NULL WHERE id=1'),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    const proposals: { id: number }[] = await database.query(
      "INSERT INTO proposals (project_id,creator_id,channel,expires_at) VALUES (1,$1,'web',now()+interval '1 day') RETURNING id",
      [users[0]!.id],
    );
    await database.undoLastMigration(); // MCP access
    await expect(database.undoLastMigration()).rejects.toThrow(
      'Cannot revert while proposals exist',
    );
    await database.query('DELETE FROM proposals WHERE id=$1', [proposals[0]!.id]);
    await database.undoLastMigration();
    expect(await database.query('SELECT revision_id,status FROM compile_jobs')).toEqual([
      { revision_id: 1, status: 'queued' },
    ]);
    await database.runMigrations();
    expect((await database.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  } finally {
    if (database.isInitialized) await database.destroy();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
  }
});
