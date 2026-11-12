import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProposals1793205600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE TABLE "proposals" ("id" SERIAL NOT NULL, "project_id" integer NOT NULL, "creator_id" integer NOT NULL, "channel" character varying(16) NOT NULL, "status" character varying(16) NOT NULL DEFAULT \'draft\', "version" integer NOT NULL DEFAULT \'1\', "accepted_revision_id" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "proposals_id_project_key" UNIQUE ("id", "project_id"), CONSTRAINT "proposals_version_check" CHECK ("version" >= 1 AND "version" <= 100), CONSTRAINT "proposals_status_check" CHECK ("status" IN (\'draft\', \'accepted\', \'rejected\')), CONSTRAINT "proposals_pkey" PRIMARY KEY ("id"))',
    );
    await runner.query(
      'CREATE INDEX "proposals_project_id_idx" ON "proposals"  ("project_id", "id") ',
    );
    await runner.query(
      'CREATE TABLE "proposal_candidates" ("id" SERIAL NOT NULL, "proposal_id" integer NOT NULL, "project_id" integer NOT NULL, "version" integer NOT NULL, "base_revision_id" integer NOT NULL, "snapshot_id" integer NOT NULL, "summary" character varying(500) NOT NULL, "operations" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "proposal_candidates_target_key" UNIQUE ("proposal_id", "version", "project_id", "snapshot_id"), CONSTRAINT "proposal_candidates_version_key" UNIQUE ("proposal_id", "version"), CONSTRAINT "proposal_candidates_version_check" CHECK ("version" >= 1 AND "version" <= 100), CONSTRAINT "proposal_candidates_pkey" PRIMARY KEY ("id"))',
    );
    await runner.query(
      'CREATE TABLE "proposal_validations" ("id" SERIAL NOT NULL, "proposal_id" integer NOT NULL, "project_id" integer NOT NULL, "candidate_version" integer NOT NULL, "snapshot_id" integer NOT NULL, "compile_job_id" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "proposal_validations_pkey" PRIMARY KEY ("id"))',
    );
    await runner.query(
      'CREATE INDEX "proposal_validations_candidate_idx" ON "proposal_validations"  ("proposal_id", "candidate_version", "id") ',
    );
    await runner.query('ALTER TABLE "compile_jobs" ADD "proposal_id" integer');
    await runner.query('ALTER TABLE "compile_jobs" ADD "candidate_version" integer');
    await runner.query('ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_revision_fkey"');
    await runner.query('ALTER TABLE "compile_jobs" ALTER COLUMN "revision_id" DROP NOT NULL');
    await runner.query(
      'ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_target_check" CHECK (("revision_id" IS NOT NULL AND "proposal_id" IS NULL AND "candidate_version" IS NULL) OR ("revision_id" IS NULL AND "proposal_id" IS NOT NULL AND "candidate_version" IS NOT NULL))',
    );
    await runner.query(
      'ALTER TABLE "proposals" ADD CONSTRAINT "proposals_accepted_revision_fkey" FOREIGN KEY ("accepted_revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "proposals" ADD CONSTRAINT "proposals_creator_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
    );
    await runner.query(
      'ALTER TABLE "proposal_candidates" ADD CONSTRAINT "proposal_candidates_snapshot_fkey" FOREIGN KEY ("snapshot_id", "project_id") REFERENCES "project_snapshots"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "proposal_candidates" ADD CONSTRAINT "proposal_candidates_base_fkey" FOREIGN KEY ("base_revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "proposal_candidates" ADD CONSTRAINT "proposal_candidates_proposal_fkey" FOREIGN KEY ("proposal_id", "project_id") REFERENCES "proposals"("id","project_id") ON DELETE CASCADE ON UPDATE NO ACTION',
    );
    await runner.query(
      'ALTER TABLE "proposal_validations" ADD CONSTRAINT "proposal_validations_job_fkey" FOREIGN KEY ("compile_job_id") REFERENCES "compile_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "proposal_validations" ADD CONSTRAINT "proposal_validations_candidate_fkey" FOREIGN KEY ("proposal_id", "candidate_version", "project_id", "snapshot_id") REFERENCES "proposal_candidates"("proposal_id","version","project_id","snapshot_id") ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_revision_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query(
      'ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_candidate_fkey" FOREIGN KEY ("proposal_id", "candidate_version", "project_id", "snapshot_id") REFERENCES "proposal_candidates"("proposal_id","version","project_id","snapshot_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const [row]: { used: boolean }[] = await runner.query(
      'SELECT EXISTS(SELECT 1 FROM proposals) AS used',
    );
    if (row?.used) throw new Error('Cannot revert while proposals exist');
    await runner.query('ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_candidate_fkey"');
    await runner.query('ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_revision_fkey"');
    await runner.query(
      'ALTER TABLE "proposal_validations" DROP CONSTRAINT "proposal_validations_candidate_fkey"',
    );
    await runner.query(
      'ALTER TABLE "proposal_validations" DROP CONSTRAINT "proposal_validations_job_fkey"',
    );
    await runner.query(
      'ALTER TABLE "proposal_candidates" DROP CONSTRAINT "proposal_candidates_proposal_fkey"',
    );
    await runner.query(
      'ALTER TABLE "proposal_candidates" DROP CONSTRAINT "proposal_candidates_base_fkey"',
    );
    await runner.query(
      'ALTER TABLE "proposal_candidates" DROP CONSTRAINT "proposal_candidates_snapshot_fkey"',
    );
    await runner.query('ALTER TABLE "proposals" DROP CONSTRAINT "proposals_project_fkey"');
    await runner.query('ALTER TABLE "proposals" DROP CONSTRAINT "proposals_creator_fkey"');
    await runner.query(
      'ALTER TABLE "proposals" DROP CONSTRAINT "proposals_accepted_revision_fkey"',
    );
    await runner.query('ALTER TABLE "compile_jobs" DROP CONSTRAINT "compile_jobs_target_check"');
    await runner.query('ALTER TABLE "compile_jobs" ALTER COLUMN "revision_id" SET NOT NULL');
    await runner.query(
      'ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_revision_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    );
    await runner.query('ALTER TABLE "compile_jobs" DROP COLUMN "candidate_version"');
    await runner.query('ALTER TABLE "compile_jobs" DROP COLUMN "proposal_id"');
    await runner.query('DROP INDEX "proposal_validations_candidate_idx"');
    await runner.query('DROP TABLE "proposal_validations"');
    await runner.query('DROP TABLE "proposal_candidates"');
    await runner.query('DROP INDEX "proposals_project_id_idx"');
    await runner.query('DROP TABLE "proposals"');
  }
}
