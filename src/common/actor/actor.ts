/** Populated by authentication adapters, never directly from a request body. */
export interface UserActor {
  userId: string;
  channel: 'web' | 'mcp';
  credentialId: string;
  scopes: readonly string[];
  /** null means explicitly granted access to all projects owned by this user. */
  projectIds: readonly string[] | null;
}

export interface SystemActor {
  channel: 'system';
  jobId: string;
}

export type Actor = UserActor | SystemActor;
