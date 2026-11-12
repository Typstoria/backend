import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountSettings1794498000000 implements MigrationInterface {
  name = 'AddAccountSettings1794498000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" ADD "name" character varying(80)');
    // Recreate the enum so the new value is usable in this transaction as well.
    await queryRunner.query(
      'ALTER TYPE "identity_challenge_kind" RENAME TO "identity_challenge_kind_old"',
    );
    await queryRunner.query(
      "CREATE TYPE \"identity_challenge_kind\" AS ENUM ('verify_email', 'reset_password', 'delete_account')",
    );
    await queryRunner.query(
      'ALTER TABLE "identity_challenges" ALTER COLUMN "kind" TYPE "identity_challenge_kind" USING "kind"::text::"identity_challenge_kind"',
    );
    await queryRunner.query('DROP TYPE "identity_challenge_kind_old"');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM "identity_challenges" WHERE kind = \'delete_account\'');
    await queryRunner.query(
      'ALTER TYPE "identity_challenge_kind" RENAME TO "identity_challenge_kind_old"',
    );
    await queryRunner.query(
      "CREATE TYPE \"identity_challenge_kind\" AS ENUM ('verify_email', 'reset_password')",
    );
    await queryRunner.query(
      'ALTER TABLE "identity_challenges" ALTER COLUMN "kind" TYPE "identity_challenge_kind" USING "kind"::text::"identity_challenge_kind"',
    );
    await queryRunner.query('DROP TYPE "identity_challenge_kind_old"');
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN "name"');
  }
}
