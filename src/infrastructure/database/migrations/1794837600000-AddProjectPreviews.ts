import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectPreviews1794837600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE projects
      ADD preview_blob_id integer,
      ADD preview_revision_id integer,
      ADD preview_job_id integer,
      ADD preview_version varchar(64),
      ADD CONSTRAINT projects_preview_check CHECK (
        (preview_blob_id IS NULL AND preview_revision_id IS NULL AND preview_job_id IS NULL AND preview_version IS NULL)
        OR (preview_blob_id IS NOT NULL AND preview_revision_id IS NOT NULL AND preview_job_id IS NOT NULL AND preview_version IS NOT NULL)
      ),
      ADD CONSTRAINT projects_preview_blob_fkey FOREIGN KEY (preview_blob_id, owner_id)
        REFERENCES blobs(id, owner_id) DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT projects_preview_revision_fkey FOREIGN KEY (preview_revision_id, id)
        REFERENCES project_revisions(id, project_id) DEFERRABLE INITIALLY DEFERRED`);
    await runner.query(`ALTER TABLE compile_jobs
      ADD preview_status varchar(16),
      ADD preview_attempts integer NOT NULL DEFAULT 0,
      ADD preview_available_at timestamptz,
      ADD preview_lease_token uuid,
      ADD preview_lease_expires_at timestamptz,
      ADD CONSTRAINT compile_jobs_preview_status_check CHECK (
        preview_status IS NULL OR preview_status IN ('queued', 'running', 'ready', 'failed', 'skipped')
      ),
      ADD CONSTRAINT compile_jobs_preview_attempts_check CHECK (preview_attempts >= 0 AND preview_attempts <= 3)`);
    await runner.query(
      'CREATE INDEX compile_jobs_preview_dispatch_idx ON compile_jobs (preview_status, preview_available_at)',
    );
    // Backfill only the newest successful accepted revision per active project.
    // Rendering uses immutable source snapshots and does not depend on the PDF's seven-day TTL.
    await runner.query(`UPDATE compile_jobs SET preview_status = 'queued', preview_available_at = now()
      WHERE id IN (
        SELECT DISTINCT ON (job.project_id) job.id FROM compile_jobs job
        JOIN projects project ON project.id = job.project_id AND project.deleted_at IS NULL
        WHERE job.status = 'succeeded' AND job.revision_id IS NOT NULL AND job.proposal_id IS NULL
        ORDER BY job.project_id, job.revision_id DESC, job.id DESC
      )`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE projects
      DROP CONSTRAINT projects_preview_revision_fkey,
      DROP CONSTRAINT projects_preview_blob_fkey,
      DROP CONSTRAINT projects_preview_check,
      DROP COLUMN preview_blob_id, DROP COLUMN preview_revision_id,
      DROP COLUMN preview_job_id, DROP COLUMN preview_version`);
    await runner.query('DROP INDEX compile_jobs_preview_dispatch_idx');
    await runner.query(`ALTER TABLE compile_jobs
      DROP CONSTRAINT compile_jobs_preview_status_check,
      DROP CONSTRAINT compile_jobs_preview_attempts_check,
      DROP COLUMN preview_status, DROP COLUMN preview_attempts, DROP COLUMN preview_available_at,
      DROP COLUMN preview_lease_token, DROP COLUMN preview_lease_expires_at`);
  }
}
