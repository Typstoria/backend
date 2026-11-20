import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RetireMcpPat1795096800000 implements MigrationInterface {
  name = 'RetireMcpPat1795096800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "UPDATE mcp_access_grants SET revoked_at = now() WHERE kind = 'pat' AND revoked_at IS NULL",
    );
  }

  async down(): Promise<void> {
    // Revoked credentials stay revoked if the application is rolled back.
  }
}
