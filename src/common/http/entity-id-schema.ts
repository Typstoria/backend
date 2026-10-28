import { MAX_ENTITY_ID } from '../ids/numeric-id';

/** Explicit examples prevent Swagger from using the integer upper bound as a sample ID. */
export const entityIdSchema = {
  type: 'integer',
  format: 'int32',
  minimum: 1,
  maximum: MAX_ENTITY_ID,
  example: 1,
} as const;
