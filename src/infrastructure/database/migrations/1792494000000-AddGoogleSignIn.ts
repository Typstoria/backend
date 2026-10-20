import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGoogleSignIn1792494000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ADD "google_subject" varchar(255)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "users_google_subject_key" ON "users" ("google_subject")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ passwordless: boolean }> = await queryRunner.query(
      `SELECT EXISTS(SELECT 1 FROM "users" WHERE "password_hash" IS NULL) AS "passwordless"`,
    );
    if (rows[0]?.passwordless) {
      throw new Error('Cannot revert Google sign-in while passwordless accounts exist');
    }
    await queryRunner.query(`DROP INDEX "users_google_subject_key"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "google_subject"`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL`);
  }
}
