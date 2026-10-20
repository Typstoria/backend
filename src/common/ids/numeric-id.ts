export const MAX_ENTITY_ID = 2_147_483_647;

/** PostgreSQL integer IDs are positive, canonical decimal values. */
export function parseEntityId(value: string): number | undefined {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return;
  const id = Number(value);
  return id <= MAX_ENTITY_ID ? id : undefined;
}
