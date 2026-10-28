import type { DataSource } from 'typeorm';
import type { CompileProcessor } from '../application/compile-processor.service';

/** Jobs themselves are the durable queue. Select one due job per owner to avoid head-of-line blocking. */
export async function processQueuedCompilations(
  database: DataSource,
  processor: CompileProcessor,
): Promise<void> {
  await processor.recoverExpired();
  const jobs: { id: number }[] = await database.query(`
    SELECT id FROM (
      SELECT DISTINCT ON (owner_id) id, owner_id FROM compile_jobs AS job
      WHERE status = 'queued' AND available_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM compile_jobs AS running
          WHERE running.owner_id = job.owner_id AND running.status = 'running'
        )
      ORDER BY owner_id, id
    ) AS candidates ORDER BY id LIMIT 2
  `);
  // Claim/fencing in the processor also protects against overlapping worker processes.
  const results = await Promise.allSettled(jobs.map(({ id }) => processor.process(id)));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
