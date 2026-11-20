import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { IdentityMailer, IdentityMail } from '../../src/infrastructure/mail/identity-mailer';
import { PasswordHasher } from '../../src/modules/identity/infrastructure/password-hasher.service';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { AccountService } from '../../src/modules/identity/application/account.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import {
  ChallengeKind,
  IdentityChallenge,
} from '../../src/modules/identity/infrastructure/persistence/entities/identity-challenge.entity';
import { createToken, hashToken } from '../../src/modules/identity/domain/tokens';
import { Project } from '../../src/modules/projects/infrastructure/persistence/entities/project.entity';
import { AccessGrant } from '../../src/modules/access/access-grant.entity';
import { AccessService } from '../../src/modules/access/access.service';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { AppConfigService } from '../../src/config/app-config.service';

describe('Account settings with real PostgreSQL (no real emails)', () => {
  let app: INestApplication;
  let database: DataSource;
  let emails: IdentityMail[];
  let ids: number[];
  let root: string;
  const password = ' original password ';

  beforeEach(async () => {
    emails = [];
    ids = [];
    root = await mkdtemp(join(tmpdir(), 'typstoria-account-'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IdentityMailer)
      .useValue({
        send: async (mail: IdentityMail) => {
          emails.push(mail);
        },
      })
      .overrideProvider(LocalBlobStorage)
      .useValue(new LocalBlobStorage({ blobStoragePath: root } as AppConfigService))
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
  });
  afterEach(async () => {
    try {
      if (database?.isInitialized && ids.length)
        await database.getRepository(User).delete({ id: In(ids) });
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  async function account(hasPassword = true) {
    const email = `settings-${randomUUID()}@example.test`;
    const user = await database.getRepository(User).save({
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
      passwordHash: hasPassword ? await app.get(PasswordHasher).hash(password) : null,
    });
    ids.push(user.id);
    const { accessToken } = await app.get(SessionService).create(user, 'account test');
    const agent = request.agent(app.getHttpServer());
    agent.auth(accessToken, { type: 'bearer' });
    return { user, agent, accessToken };
  }
  const deletionToken = () => emails.at(-1)!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;

  it('edits only the display name, preserves credentials, validates and prevents clearing', async () => {
    const { agent, user } = await account();
    const before = await agent.get('/api/auth/me').expect(200);
    expect(before.body).toMatchObject({ name: null, hasPassword: true, email: user.email });
    const response = await agent.patch('/api/auth/me').send({ name: '  Нестор 📝  ' }).expect(200);
    expect(response.body).toMatchObject({ name: 'Нестор 📝', id: user.id, email: user.email });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|googleSubject|authVersion/);
    await agent
      .get('/api/auth/me')
      .expect(200)
      .expect(({ body }) => expect(body.name).toBe('Нестор 📝'));
    for (const body of [
      {},
      { name: '' },
      { name: null },
      { name: '   ' },
      { name: 'x'.repeat(81) },
      { name: 'one\ntwo' },
      { name: false },
      { name: 'OK', email: 'new@example.test' },
      { name: 'OK', googleSubject: 'bad' },
    ])
      await agent.patch('/api/auth/me').send(body).expect(400);
    await agent
      .get('/api/auth/me')
      .expect(200)
      .expect(({ body }) => expect(body.name).toBe('Нестор 📝'));
    await request(app.getHttpServer())
      .patch('/api/auth/me')
      .send({ name: 'anonymous' })
      .expect(401);
  });

  it('checks the current password, revokes all sessions and old reset/deletion links', async () => {
    const { agent, user } = await account();
    const second = await app.get(SessionService).create(user, 'second tab');
    const project = await agent
      .post('/api/projects')
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'MCP access before password change' })
      .expect(201);
    const access = app.get(AccessService);
    const grantId = 'account-settings-' + randomUUID();
    await access.createConnection(user, 'account-settings-test-client', grantId, {
      name: 'Account settings test',
      projectIds: [project.body.projectId],
      scopes: ['projects:read'],
    });
    const resolveGrant = () =>
      access.resolveOAuth(
        grantId,
        String(user.id),
        'account-settings-test-client',
        new Set(['projects:read']),
      );
    await expect(resolveGrant()).resolves.toMatchObject({ userId: user.id });
    const reset = createToken();
    await database.getRepository(IdentityChallenge).save({
      userId: user.id,
      kind: ChallengeKind.ResetPassword,
      tokenHash: hashToken(reset),
      expiresAt: new Date(Date.now() + 60000),
    });
    await agent.post('/api/auth/request-account-deletion').expect(202);
    const deletion = deletionToken();
    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'wrong', newPassword: 'newpass' })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('CURRENT_PASSWORD_INVALID'));
    await agent.get('/api/auth/me').expect(200);
    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: password, newPassword: 'short' })
      .expect(400);
    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: password, newPassword: ' new password ' })
      .expect(204);
    await expect(resolveGrant()).resolves.toBeUndefined();
    await agent.get('/api/auth/me').expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(second.accessToken, { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .send({ token: reset, password: 'resetpass' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/auth/delete-account')
      .send({ token: deletion })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: user.email, password: ' new password ' })
      .expect(200);
  });

  it('does not set a password on a passwordless account and supports its email-confirmed deletion', async () => {
    const { agent } = await account(false);
    await agent
      .get('/api/auth/me')
      .expect(200)
      .expect(({ body }) => expect(body.hasPassword).toBe(false));
    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'any', newPassword: 'newpass' })
      .expect(403);
    await agent.post('/api/auth/request-account-deletion').expect(202);
    await request(app.getHttpServer())
      .post('/api/auth/delete-account')
      .send({ token: deletionToken() })
      .expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('only deletes on explicit valid POST, removes owned data and leaves another owner intact', async () => {
    const { agent, user } = await account();
    const other = await account();
    const created = await agent
      .post('/api/projects')
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Private' })
      .expect(201);
    const grantId = 'account-deletion-' + randomUUID();
    const access = app.get(AccessService);
    await access.createConnection(user, 'account-deletion-test-client', grantId, {
      name: 'Account deletion test',
      projectIds: [created.body.projectId],
      scopes: ['projects:read'],
    });
    const otherProject = await other.agent
      .post('/api/projects')
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Other' })
      .expect(201);
    await request(app.getHttpServer()).post('/api/auth/request-account-deletion').expect(401);
    await agent.post('/api/auth/request-account-deletion').expect(202);
    const token = deletionToken();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain('/auth/delete-account#token=');
    await agent.post('/api/auth/request-account-deletion').expect(202);
    expect(emails).toHaveLength(1);
    await request(app.getHttpServer()).get('/api/auth/delete-account').expect(404);
    await agent.get('/api/auth/me').expect(200);
    const results = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer()).post('/api/auth/delete-account').send({ token }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([204, 400]);
    expect(await database.getRepository(User).countBy({ id: user.id })).toBe(0);
    expect(await database.getRepository(Project).countBy({ id: created.body.projectId })).toBe(0);
    const grant = await database.getRepository(AccessGrant).findOneBy({ oauthGrantId: grantId });
    expect(grant).toBeNull();
    await expect(
      access.resolveOAuth(
        grantId,
        String(user.id),
        'account-deletion-test-client',
        new Set(['projects:read']),
      ),
    ).resolves.toBeUndefined();
    await agent.get(`/api/projects/${created.body.projectId}`).expect(401);
    await other.agent.get(`/api/projects/${otherProject.body.projectId}`).expect(200);
    await other.agent.get('/api/auth/me').expect(200);
  });

  it('rejects wrong-purpose, expired and superseded deletion links', async () => {
    const { agent, user } = await account();
    const reset = createToken();
    await database.getRepository(IdentityChallenge).save({
      userId: user.id,
      kind: ChallengeKind.ResetPassword,
      tokenHash: hashToken(reset),
      expiresAt: new Date(Date.now() + 60000),
    });
    await request(app.getHttpServer())
      .post('/api/auth/delete-account')
      .send({ token: reset })
      .expect(400);
    await agent.post('/api/auth/request-account-deletion').expect(202);
    const first = deletionToken();
    await database
      .getRepository(IdentityChallenge)
      .update(
        { userId: user.id, kind: ChallengeKind.DeleteAccount },
        { createdAt: new Date(Date.now() - 301000) },
      );
    await agent.post('/api/auth/request-account-deletion').expect(202);
    const second = deletionToken();
    await request(app.getHttpServer())
      .post('/api/auth/delete-account')
      .send({ token: first })
      .expect(400);
    await database
      .getRepository(IdentityChallenge)
      .update(
        { userId: user.id, kind: ChallengeKind.DeleteAccount },
        { expiresAt: new Date(Date.now() - 1) },
      );
    await request(app.getHttpServer())
      .post('/api/auth/delete-account')
      .send({ token: second })
      .expect(400);
    await agent.get('/api/auth/me').expect(200);
  });

  it('does not let a session revoked after the guard mutate the account', async () => {
    const { user, accessToken, agent } = await account();
    const identity = (await app.get(SessionService).resolve(accessToken))!;
    await agent.post('/api/auth/logout').expect(204);
    await expect(app.get(AccountService).update(identity, 'stale')).rejects.toThrow('valid Bearer');
    expect((await database.getRepository(User).findOneByOrFail({ id: user.id })).name).toBeNull();
  });
});
