import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveUserStatus1792488600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "status"`);
    await queryRunner.query(`DROP TYPE "user_status"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Account blocking is no longer supported; rollback restores all users as active.
    await queryRunner.query(`CREATE TYPE "user_status" AS ENUM ('active', 'suspended')`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD "status" "user_status" NOT NULL DEFAULT 'active'`,
    );
  }
}
