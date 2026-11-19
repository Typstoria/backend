import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/infrastructure/database/database.options';
import { validateDatabaseEnvironment } from '../../src/config/environment';
import { AddSnapshotDirectories1795093200000 } from '../../src/infrastructure/database/migrations/1795093200000-AddSnapshotDirectories';

it('defaults historical snapshots to no directories without rewriting hashes and refuses a lossy downgrade', async () => {
  const schema = `directories_${randomUUID().replaceAll('-', '')}`;
  const database = await new DataSource(
    createDatabaseOptions(validateDatabaseEnvironment(process.env)),
  ).initialize();
  const runner = database.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}"`);
    await runner.query('CREATE TABLE project_snapshots (id integer, manifest_hash text)');
    await runner.query("INSERT INTO project_snapshots VALUES (1, 'legacy-hash')");
    const migration = new AddSnapshotDirectories1795093200000();
    await migration.up(runner);
    expect(await runner.query('SELECT * FROM project_snapshots')).toEqual([
      { id: 1, manifest_hash: 'legacy-hash', directories: [] },
    ]);
    await runner.query("UPDATE project_snapshots SET directories = ARRAY['empty']");
    await expect(migration.down(runner)).rejects.toThrow(
      'Cannot revert while explicit snapshot directories exist',
    );
    await runner.query("UPDATE project_snapshots SET directories = '{}'::text[]");
    await migration.down(runner);
    expect(await runner.query('SELECT * FROM project_snapshots')).toEqual([
      { id: 1, manifest_hash: 'legacy-hash' },
    ]);
  } finally {
    await runner.query('RESET search_path');
    await runner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await runner.release();
    await database.destroy();
  }
});
