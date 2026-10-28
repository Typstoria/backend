/** Populated by authentication adapters, never directly from a request body. */
export interface UserActor {
  userId: number;
  channel: 'web' | 'mcp';
  credentialId: number;
}
