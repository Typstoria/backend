import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UseNumericIdentityIds1792330200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await this.replaceIds(queryRunner, true);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Rows and relationships survive rollback; restored UUID values are newly generated.
    await this.replaceIds(queryRunner, false);
  }

  private async replaceIds(queryRunner: QueryRunner, numeric: boolean): Promise<void> {
    const tables = ['users', 'web_sessions', 'identity_challenges'] as const;
    const children = ['web_sessions', 'identity_challenges'] as const;
    await queryRunner.query(
      `LOCK TABLE "users", "web_sessions", "identity_challenges" IN ACCESS EXCLUSIVE MODE`,
    );

    // Keep old primary keys until every foreign key has been mapped to the new IDs.
    for (const table of tables) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD "replacement_id" ${numeric ? 'SERIAL' : 'uuid NOT NULL DEFAULT gen_random_uuid()'}`,
      );
    }
    for (const table of children) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD "replacement_user_id" ${numeric ? 'integer' : 'uuid'}`,
      );
      await queryRunner.query(
        `UPDATE "${table}" AS child SET "replacement_user_id" = parent."replacement_id" FROM "users" AS parent WHERE child."user_id" = parent."id"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "replacement_user_id" SET NOT NULL`,
      );
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${table}_user_id_fkey"`);
    }
    for (const table of tables) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${table}_pkey"`);
    }
    for (const table of children) {
      // PostgreSQL also removes indexes depending on the old user_id column.
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "user_id"`);
      await queryRunner.query(
        `ALTER TABLE "${table}" RENAME COLUMN "replacement_user_id" TO "user_id"`,
      );
    }
    for (const table of tables) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "id"`);
      await queryRunner.query(`ALTER TABLE "${table}" RENAME COLUMN "replacement_id" TO "id"`);
      if (numeric) {
        await queryRunner.query(
          `ALTER SEQUENCE "${table}_replacement_id_seq" RENAME TO "${table}_id_seq"`,
        );
      }
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`,
      );
    }
    for (const table of children) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX "web_sessions_user_id_idx" ON "web_sessions" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "identity_challenges_user_kind_idx" ON "identity_challenges" ("user_id", "kind", "created_at")`,
    );
    // A credential's public ID changed, so previously issued access tokens must be replaced.
    await queryRunner.query(
      `UPDATE "web_sessions" SET "revoked_at" = now() WHERE "revoked_at" IS NULL`,
    );
  }
}
