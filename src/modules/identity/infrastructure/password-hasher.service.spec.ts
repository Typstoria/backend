import { PasswordHasher } from './password-hasher.service';

describe('PasswordHasher', () => {
  // Real Argon2 operations need extra time on busy development hosts.
  it('uses salted Argon2id and preserves all password characters', async () => {
    const hasher = new PasswordHasher();
    const password = '  Test password з пробілами  ';
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(first).not.toBe(second);
    expect(await hasher.verify(password, first)).toBe(true);
    expect(await hasher.verify(password.trim(), first)).toBe(false);
    expect(await hasher.verify(password)).toBe(false);
    expect(await hasher.verify(password, null)).toBe(false);
  }, 15000);
});
