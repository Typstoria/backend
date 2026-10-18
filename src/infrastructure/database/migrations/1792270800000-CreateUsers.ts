import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsers1792270800000 implements MigrationInterface {
  name = 'CreateUsers1792270800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "user_status" AS ENUM ('active', 'suspended')`);
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar(254) NOT NULL,
        "normalized_email" varchar(254) NOT NULL,
        "password_hash" text NOT NULL,
        "email_verified_at" timestamptz,
        "status" "user_status" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "users_pkey" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "users_normalized_email_key" ON "users" ("normalized_email")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "user_status"`);
  }
}
