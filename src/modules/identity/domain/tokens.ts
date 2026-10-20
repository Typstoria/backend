import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}
export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function matchesToken(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
