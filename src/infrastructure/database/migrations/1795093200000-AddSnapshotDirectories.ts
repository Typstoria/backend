import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSnapshotDirectories1795093200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE project_snapshots ADD COLUMN directories text[] NOT NULL DEFAULT '{}'::text[]`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM project_snapshots WHERE cardinality(directories) > 0) THEN
        RAISE EXCEPTION 'Cannot revert while explicit snapshot directories exist';
      END IF;
    END $$`);
    await queryRunner.query('ALTER TABLE project_snapshots DROP COLUMN directories');
  }
}
