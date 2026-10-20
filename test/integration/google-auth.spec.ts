import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { IdentityMailer } from '../../src/infrastructure/mail/identity-mailer';
import {
  GoogleTokenVerifier,
  GoogleProfile,
} from '../../src/modules/identity/infrastructure/google-token-verifier';
import { PasswordHasher } from '../../src/modules/identity/infrastructure/password-hasher.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { WebSession } from '../../src/modules/identity/infrastructure/persistence/entities/web-session.entity';
import { IdentityChallenge } from '../../src/modules/identity/infrastructure/persistence/entities/identity-challenge.entity';

describe('Google sign-in with PostgreSQL (no external Google or Mailjet requests)', () => {
  let app: INestApplication;
  let database: DataSource;
  let emails: string[];
  let profile: GoogleProfile;
  const verifier = { verify: jest.fn() };
  const mailer = { send: jest.fn() };

  beforeEach(async () => {
    emails = [];
    profile = { subject: randomUUID(), email: email() };
    verifier.verify.mockReset().mockImplementation(async () => ({ ...profile }));
    mailer.send.mockReset().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleTokenVerifier)
      .useValue(verifier)
      .overrideProvider(IdentityMailer)
      .useValue(mailer)
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    database = app.get(DataSource);
  });

  afterEach(async () => {
    try {
      if (database?.isInitialized && emails.length) {
        await database.getRepository(User).delete({ normalizedEmail: In(emails) });
      }
    } finally {
      await app?.close();
    }
  });

  function email(): string {
    const value = `google-${randomUUID()}@example.test`;
    emails.push(value);
    return value;
  }
  function google() {
    return request(app.getHttpServer())
      .post('/api/auth/google')
      .send({ idToken: 'google-test-credential' });
  }
  async function localUser(verified = true) {
    return database.getRepository(User).save({
      email: profile.email,
      normalizedEmail: profile.email,
      passwordHash: await app.get(PasswordHasher).hash('abcdef'),
      emailVerifiedAt: verified ? new Date() : null,
    });
  }

  it('creates a verified passwordless user and issues the normal opaque Typstoria token', async () => {
    const first = await google().expect(200);
    expect(first.body.accessToken).toMatch(/^[1-9][0-9]*\.[A-Za-z0-9_-]{43}$/);
    expect(first.body.tokenType).toBe('Bearer');
    expect(first.body.user.emailVerified).toBe(true);
    expect(typeof first.body.user.id).toBe('number');
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(first.body)).not.toMatch(
      /googleSubject|passwordHash|secretHash|refreshToken/,
    );
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(first.body.accessToken, { type: 'bearer' })
      .expect(200);
    const second = await google().expect(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(await database.getRepository(User).countBy({ normalizedEmail: profile.email })).toBe(1);
    const stored = await database.getRepository(User).findOne({
      where: { id: first.body.user.id },
      select: { id: true, googleSubject: true, passwordHash: true },
    });
    expect(stored?.googleSubject).toBe(profile.subject);
    expect(stored?.passwordHash).toBeNull();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does not set a password through duplicate registration or email-only recovery', async () => {
    const signedIn = await google().expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: profile.email, password: 'abcdef' })
      .expect(202);
    await request(app.getHttpServer())
      .post('/api/auth/forgot-password')
      .send({ email: profile.email })
      .expect(202);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: profile.email, password: 'abcdef' })
      .expect(401);
    expect(
      await database.getRepository(IdentityChallenge).countBy({ userId: signedIn.body.user.id }),
    ).toBe(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'never automatically links a matching local email (verified: %s)',
    async (verified) => {
      const local = await localUser(verified);
      const result = await google().expect(409);
      expect(result.body.error.code).toBe('GOOGLE_ACCOUNT_LINK_REQUIRED');
      const stored = await database.getRepository(User).findOneByOrFail({ id: local.id });
      expect(stored.googleSubject).toBeNull();
      expect(Boolean(stored.emailVerifiedAt)).toBe(verified);
      expect(await database.getRepository(WebSession).countBy({ userId: local.id })).toBe(0);
    },
  );

  it('links only after verified local sign-in and preserves password authentication', async () => {
    const user = await localUser();
    await request(app.getHttpServer())
      .post('/api/auth/google/link')
      .send({ idToken: 'credential' })
      .expect(401);
    const login = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: profile.email, password: 'abcdef' });
    const local = await login().expect(200);
    const link = () =>
      request(app.getHttpServer())
        .post('/api/auth/google/link')
        .auth(local.body.accessToken, { type: 'bearer' })
        .send({ idToken: 'credential' });
    await link().expect(200);
    await link().expect(200);
    expect((await google().expect(200)).body.user.id).toBe(user.id);
    await login().expect(200);
    profile = { ...profile, email: email() };
    await link().expect(409);
    profile = { subject: randomUUID(), email: user.normalizedEmail };
    await link().expect(409);
  });

  it('creates only one user for concurrent first logins', async () => {
    const results = await Promise.all([google().expect(200), google().expect(200)]);
    expect(results[0]!.body.user.id).toBe(results[1]!.body.user.id);
    expect(await database.getRepository(User).countBy({ googleSubject: profile.subject })).toBe(1);
  });

  it('identifies returning users by Google subject without changing or merging email addresses', async () => {
    const initial = await google().expect(200);
    const originalEmail = profile.email;
    profile.email = email();
    await localUser();
    const returned = await google().expect(200);
    expect(returned.body.user.id).toBe(initial.body.user.id);
    expect(returned.body.user.email).toBe(originalEmail);
    expect(await database.getRepository(User).countBy({ normalizedEmail: profile.email })).toBe(1);
  });

  it('rejects form posts and hostile origins before verifying a credential', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/google')
      .type('form')
      .send({ idToken: 'credential' })
      .expect(415);
    await request(app.getHttpServer())
      .post('/api/auth/google')
      .set('Origin', 'https://hostile.example')
      .send({ idToken: 'credential' })
      .expect(403);
    await request(app.getHttpServer()).post('/api/auth/google').send({}).expect(400);
    await request(app.getHttpServer())
      .post('/api/auth/google')
      .send({ idToken: 'credential', email: profile.email })
      .expect(400);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('returns safe errors for invalid credentials or missing configuration without creating users', async () => {
    verifier.verify.mockRejectedValueOnce(
      new UnauthorizedException({
        code: 'GOOGLE_TOKEN_INVALID',
        message: 'Invalid or expired Google credential',
      }),
    );
    const invalid = await google().expect(401);
    expect(invalid.body.error.code).toBe('GOOGLE_TOKEN_INVALID');
    expect(JSON.stringify(invalid.body)).not.toContain('google-test-credential');
    verifier.verify.mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'GOOGLE_AUTH_NOT_CONFIGURED',
        message: 'Google sign-in is not configured',
      }),
    );
    expect((await google().expect(503)).body.error.code).toBe('GOOGLE_AUTH_NOT_CONFIGURED');
    expect(await database.getRepository(User).countBy({ normalizedEmail: profile.email })).toBe(0);
  });
});
