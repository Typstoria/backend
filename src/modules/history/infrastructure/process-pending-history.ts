import type { DataSource } from 'typeorm';
import type { GitHistoryWriter } from '../application/git-history-writer.service';

export async function processPendingHistory(
  database: DataSource,
  writer: GitHistoryWriter,
): Promise<void> {
  await writer.recoverExpired();
  const projects: { projectId: number }[] = await database.query(`
    SELECT mapping.project_id AS "projectId" FROM git_revision_mappings AS mapping
    JOIN projects AS project ON project.id = mapping.project_id AND project.deleted_at IS NULL
    JOIN project_revisions AS revision ON revision.id = mapping.revision_id
    LEFT JOIN git_revision_mappings AS parent ON parent.revision_id = revision.parent_revision_id
    WHERE mapping.status <> 'ready' AND mapping.attempts < 5 AND mapping.available_at <= now()
      AND (mapping.lease_expires_at IS NULL OR mapping.lease_expires_at < now())
      AND (revision.parent_revision_id IS NULL OR parent.status = 'ready')
    GROUP BY mapping.project_id ORDER BY MIN(mapping.available_at), mapping.project_id LIMIT 2
  `);
  const results = await Promise.allSettled(
    projects.map(({ projectId }) => writer.process(projectId)),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
