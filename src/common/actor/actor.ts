/** Populated by authentication adapters, never directly from a request body. */
export interface UserActor {
  userId: number;
  channel: 'web' | 'mcp';
  credentialId: number;
  scopes: readonly string[];
  /** null means explicitly granted access to all projects owned by this user. */
  projectIds: readonly number[] | null;
}

export interface SystemActor {
  channel: 'system';
  jobId: number;
}

export type Actor = UserActor | SystemActor;
