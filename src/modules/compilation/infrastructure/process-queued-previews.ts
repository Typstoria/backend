import type { DataSource } from 'typeorm';
import type { PreviewProcessor } from '../application/preview-processor.service';

export async function processQueuedPreviews(
  database: DataSource,
  processor: PreviewProcessor,
): Promise<void> {
  await processor.recoverExpired();
  const jobs: { id: number }[] = await database.query(`SELECT id FROM (
    SELECT DISTINCT ON (owner_id) id, owner_id, revision_id FROM compile_jobs
    WHERE preview_status = 'queued' AND preview_available_at <= now()
    ORDER BY owner_id, revision_id DESC, id DESC
  ) candidates ORDER BY revision_id DESC, id DESC LIMIT 2`);
  const results = await Promise.allSettled(jobs.map(({ id }) => processor.process(id)));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
