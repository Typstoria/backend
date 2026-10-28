import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

export function requireIdempotencyKey(key: string | undefined): string {
  if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key))
    throw new BadRequestException({
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must contain 1–128 letters, digits or . _ ~ -',
    });
  return key;
}

export function mutationPayloadHash(payload: object): string {
  const json = JSON.stringify(payload, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return value;
  });
  return createHash('sha256').update(json).digest('hex');
}

export function checkIdempotencyPayload(stored: string, actual: string): void {
  if (stored !== actual)
    throw new ConflictException({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'This key was already used with another payload',
    });
}
