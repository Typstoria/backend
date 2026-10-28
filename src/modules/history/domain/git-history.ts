import type { DraftFile } from '../../projects/domain/text-changes';
import type { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';

export type HistorySyncStatus = 'pending' | 'ready' | 'failed';
export type HistoryErrorCode =
  'GIT_UNAVAILABLE' | 'GIT_DIVERGED' | 'STORAGE_UNAVAILABLE' | 'WORKER_LOST' | 'MANIFEST_MISMATCH';
export const HISTORY_ATTEMPTS = 5;
export const HISTORY_LEASE_MS = 90_000;

export interface GitRevisionInput {
  ownerId: number;
  projectId: number;
  revision: ProjectRevision;
  mainFileId: number;
  contextText: string;
  manifestHash: string;
  files: (DraftFile & { bytes: Buffer })[];
  parentSha: string | null;
  latest: boolean;
  expectedCommitSha?: string | null;
}

export class GitHistoryError extends Error {
  constructor(readonly code: HistoryErrorCode) {
    super(code);
  }
}

export abstract class GitRepository {
  abstract write(input: GitRevisionInput, signal?: AbortSignal): Promise<string>;
}
