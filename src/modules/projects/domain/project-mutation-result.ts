export interface CreatedProjectFile {
  fileId: number;
  path: string;
}

/** Persisted response for completed project mutations. */
export interface ProjectMutationResult {
  projectId: number;
  revisionId: number;
  revisionNumber: number;
  mainFileId: number;
  manifestHash: string;
  historySyncStatus: 'pending' | 'ready' | 'failed';
  restoredFromRevisionId?: number;
  createdFiles?: CreatedProjectFile[];
}
