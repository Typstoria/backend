import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import database from '../../src/infrastructure/database/data-source';
import { CreateUsers1792270800000 } from '../../src/infrastructure/database/migrations/1792270800000-CreateUsers';
import { AddIdentitySessions1792326000000 } from '../../src/infrastructure/database/migrations/1792326000000-AddIdentitySessions';
import { UseNumericIdentityIds1792330200000 } from '../../src/infrastructure/database/migrations/1792330200000-UseNumericIdentityIds';

describe('UUID to numeric ID migration on populated tables', () => {
  beforeAll(async () => {
    await database.initialize();
  });
  afterAll(async () => {
    if (database.isInitialized) await database.destroy();
  });

  it('preserves users, email challenges and ownership; supports inserts, cascades and rollback', async () => {
    const runner = database.createQueryRunner();
    const query = <T>(sql: string, parameters?: unknown[]): Promise<T> =>
      runner.query(sql, parameters);
    const schema = `numeric_ids_${randomUUID().replaceAll('-', '')}`;
    await runner.connect();
    await runner.startTransaction();
    try {
      // Every DDL statement is isolated from the user's public schema and rolled back.
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      expect(
        (await query<Array<{ current_schema: string }>>('SELECT current_schema()'))[0]
          ?.current_schema,
      ).toBe(schema);
      await new CreateUsers1792270800000().up(runner);
      await new AddIdentitySessions1792326000000().up(runner);
      for (const [index, email] of ['first@example.test', 'second@example.test'].entries()) {
        const [user] = await query<Array<{ id: string }>>(
          `INSERT INTO "users" ("email", "normalized_email", "password_hash", "email_verified_at") VALUES ($1, $1, $2, now()) RETURNING "id"`,
          [email, `password-hash-${index}`],
        );
        expect(user!.id).toMatch(/^[0-9a-f-]{36}$/);
        await runner.query(
          `INSERT INTO "web_sessions" ("user_id", "secret_hash", "auth_version", "expires_at") VALUES ($1, $2, 0, now() + interval '1 day')`,
          [user!.id, String(index).repeat(64)],
        );
        await runner.query(
          `INSERT INTO "identity_challenges" ("user_id", "kind", "token_hash", "expires_at") VALUES ($1, 'reset_password', $2, now() + interval '15 minutes')`,
          [user!.id, String(index + 2).repeat(64)],
        );
      }
      const migration = new UseNumericIdentityIds1792330200000();
      await migration.up(runner);
      const users = await query<
        Array<{ id: number; email: string; password_hash: string; email_verified_at: Date }>
      >(`SELECT * FROM "users" ORDER BY "email"`);
      expect(users).toHaveLength(2);
      for (const [index, user] of users.entries()) {
        expect(typeof user.id).toBe('number');
        expect(user.id).toBeGreaterThan(0);
        expect(user.password_hash).toBe(`password-hash-${index}`);
        expect(user.email_verified_at).toBeInstanceOf(Date);
      }
      const sessions = await query<
        Array<{ id: number; user_id: number; email: string; secret_hash: string; revoked_at: Date }>
      >(
        `SELECT s.*, u."email" FROM "web_sessions" s JOIN "users" u ON u."id" = s."user_id" ORDER BY u."email"`,
      );
      const challenges = await query<
        Array<{
          id: number;
          user_id: number;
          email: string;
          token_hash: string;
          consumed_at: Date | null;
        }>
      >(
        `SELECT c.*, u."email" FROM "identity_challenges" c JOIN "users" u ON u."id" = c."user_id" ORDER BY u."email"`,
      );
      expect(sessions).toHaveLength(2);
      expect(challenges).toHaveLength(2);
      for (const [index, user] of users.entries()) {
        expect(sessions[index]).toMatchObject({
          user_id: user.id,
          email: user.email,
          secret_hash: String(index).repeat(64),
        });
        expect(typeof sessions[index]!.id).toBe('number');
        expect(sessions[index]!.revoked_at).toBeInstanceOf(Date);
        expect(challenges[index]).toMatchObject({
          user_id: user.id,
          email: user.email,
          token_hash: String(index + 2).repeat(64),
          consumed_at: null,
        });
        expect(typeof challenges[index]!.id).toBe('number');
      }
      const [created] = await query<Array<{ id: number }>>(
        `INSERT INTO "users" ("email", "normalized_email", "password_hash") VALUES ('after@example.test', 'after@example.test', 'new-hash') RETURNING "id"`,
      );
      expect(created!.id).toBeGreaterThan(Math.max(...users.map((user) => user.id)));
      const [session] = await query<Array<{ id: number }>>(
        `INSERT INTO "web_sessions" ("user_id", "secret_hash", "auth_version", "expires_at") VALUES ($1, $2, 0, now() + interval '1 day') RETURNING "id"`,
        [created!.id, 'a'.repeat(64)],
      );
      expect(session!.id).toBeGreaterThan(Math.max(...sessions.map((value) => value.id)));
      await runner.query(`DELETE FROM "users" WHERE "id" = $1`, [created!.id]);
      expect(
        await runner.query(`SELECT * FROM "web_sessions" WHERE "user_id" = $1`, [created!.id]),
      ).toEqual([]);

      await migration.down(runner);
      const restored = await query<Array<{ id: string; email: string; password_hash: string }>>(
        `SELECT * FROM "users" ORDER BY "email"`,
      );
      expect(restored.map((user) => user.email)).toEqual(users.map((user) => user.email));
      expect(restored.map((user) => user.password_hash)).toEqual(
        users.map((user) => user.password_hash),
      );
      expect(restored.every((user) => /^[0-9a-f-]{36}$/.test(user.id))).toBe(true);
      const [counts] = await query<Array<{ sessions: number; challenges: number }>>(
        `SELECT (SELECT count(*)::integer FROM "web_sessions" s JOIN "users" u ON s."user_id" = u."id") AS sessions, (SELECT count(*)::integer FROM "identity_challenges" c JOIN "users" u ON c."user_id" = u."id") AS challenges`,
      );
      expect(counts).toEqual({ sessions: 2, challenges: 2 });
      await migration.up(runner);
      expect(
        (
          await query<Array<{ type: string }>>(
            `SELECT pg_typeof("id")::text AS type FROM "users" LIMIT 1`,
          )
        )[0]?.type,
      ).toBe('integer');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
