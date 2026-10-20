import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { IdentityMailer, IdentityMail } from '../../src/infrastructure/mail/identity-mailer';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { createToken, hashToken } from '../../src/modules/identity/domain/tokens';
import {
  ChallengeKind,
  IdentityChallenge,
} from '../../src/modules/identity/infrastructure/persistence/entities/identity-challenge.entity';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { WebSession } from '../../src/modules/identity/infrastructure/persistence/entities/web-session.entity';

@Controller('identity-test-private')
class PrivateController {
  @Get()
  get(): { ok: boolean } {
    return { ok: true };
  }
}

describe('Bearer identity with PostgreSQL and captured email (no external mail sent)', () => {
  let app: INestApplication;
  let database: DataSource;
  let emails: IdentityMail[];
  let accounts: string[];
  const password = 'abcdef';
  const newPassword = '123456';
  const mailer = { send: jest.fn() };
  type Agent = ReturnType<typeof request.agent>;

  beforeEach(async () => {
    emails = [];
    accounts = [];
    mailer.send.mockReset().mockImplementation(async (mail: IdentityMail) => {
      emails.push(mail);
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PrivateController],
    })
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
      if (database?.isInitialized && accounts.length)
        await database.getRepository(User).delete({ normalizedEmail: In(accounts) });
    } finally {
      await app?.close();
    }
  });

  function account(): string {
    const email = `auth-${randomUUID()}@example.test`;
    accounts.push(email);
    return email;
  }
  function client(): Agent {
    return request.agent(app.getHttpServer());
  }
  function token(index = emails.length - 1): string {
    const result = emails[index]?.text.match(/#token=([A-Za-z0-9_-]{43})/);
    expect(result).not.toBeNull();
    return result![1]!;
  }
  async function register(agent: Agent, email: string): Promise<void> {
    const response = await agent.post('/api/auth/register').send({ email, password }).expect(202);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.body.message).toContain('5 minutes');
  }
  async function verify(agent: Agent): Promise<void> {
    const response = await agent
      .post('/api/auth/verify-email')
      .send({ token: token() })
      .expect(200);
    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  async function login(agent: Agent, email: string, pwd = password) {
    const response = await agent.post('/api/auth/login').send({ email, password: pwd }).expect(200);
    agent.auth(response.body.accessToken, { type: 'bearer' });
    return response;
  }

  it('automatically emails on registration and issues a token only after verification and login', async () => {
    const agent = client();
    const email = account();
    await register(agent, `  ${email.toUpperCase()}  `);
    expect(emails).toHaveLength(1);
    const verification = token();
    const userBefore = await database
      .getRepository(User)
      .findOneByOrFail({ normalizedEmail: email });
    expect(userBefore.emailVerifiedAt).toBeNull();
    const anonymous = await agent.get('/api/auth/me').expect(401);
    expect(anonymous.headers['www-authenticate']).toBe('Bearer realm="Typstoria"');
    await agent.get('/api/identity-test-private').expect(401);
    const wrongPassword = await agent
      .post('/api/auth/login')
      .send({ email, password: newPassword })
      .expect(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    const unverified = await agent.post('/api/auth/login').send({ email, password }).expect(403);
    expect(unverified.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(unverified.body).not.toHaveProperty('accessToken');
    expect(unverified.headers['set-cookie']).toBeUndefined();
    expect(await database.getRepository(WebSession).countBy({ userId: userBefore.id })).toBe(0);
    await verify(agent);
    // Consuming the link confirms the email but does not sign the user in.
    await agent.get('/api/auth/me').expect(401);
    await agent.get('/api/identity-test-private').expect(401);
    await agent.post('/api/auth/verify-email').send({ token: verification }).expect(400);
    const signedIn = await login(agent, email);
    expect(signedIn.body.user.emailVerified).toBe(true);
    expect(typeof signedIn.body.user.id).toBe('number');
    expect(signedIn.body.tokenType).toBe('Bearer');
    expect(signedIn.body.accessToken).toMatch(/^[1-9][0-9]*\.[A-Za-z0-9_-]{43}$/);
    expect(new Date(signedIn.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(signedIn.headers['set-cookie']).toBeUndefined();
    expect(signedIn.headers['cache-control']).toBe('no-store');
    expect(signedIn.headers.pragma).toBe('no-cache');
    expect(signedIn.body).not.toHaveProperty('csrfToken');
    expect(signedIn.body).not.toHaveProperty('refreshToken');
    await agent.get('/api/auth/me').expect(200);
    await agent.get('/api/identity-test-private').expect(200);
    await agent.post('/api/auth/resend-verification').send({ email }).expect(202);
    expect(emails).toHaveLength(1);
    const user = await database.getRepository(User).findOneByOrFail({ normalizedEmail: email });
    expect(user.passwordHash).toBeUndefined();
    const challenge = await database
      .getRepository(IdentityChallenge)
      .createQueryBuilder('challenge')
      .addSelect('challenge.tokenHash')
      .where('challenge.userId = :id', { id: user.id })
      .getOneOrFail();
    expect(challenge.tokenHash).toBe(hashToken(verification));
    expect(JSON.stringify(signedIn.body)).not.toMatch(/passwordHash|authVersion|secretHash/);
  });

  it('blocks legacy unverified tokens on every private route and refuses direct token issuance', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    const user = await database.getRepository(User).findOneByOrFail({ normalizedEmail: email });
    await expect(app.get(SessionService).create(user, 'unverified user')).rejects.toThrow(
      'Confirm your email before signing in',
    );
    expect(await database.getRepository(WebSession).countBy({ userId: user.id })).toBe(0);
    // Simulate a token issued before mandatory verification was introduced.
    const secret = createToken();
    const session = await database.getRepository(WebSession).save({
      userId: user.id,
      secretHash: hashToken(secret),
      authVersion: user.authVersion,
      userAgent: 'legacy test',
      expiresAt: new Date(Date.now() + 60000),
    });
    const accessToken = `${session.id}.${secret}`;
    for (const path of ['/api/auth/me', '/api/identity-test-private']) {
      const result = await request(app.getHttpServer())
        .get(path)
        .auth(accessToken, { type: 'bearer' })
        .expect(403);
      expect(result.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    }
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .auth(accessToken, { type: 'bearer' })
      .expect(403);
    await verify(agent);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(accessToken, { type: 'bearer' })
      .expect(401);
    await login(agent, email);
  });

  it('accepts credentials only in the Bearer header and never falls back to cookies, query or body', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    await verify(agent);
    const { body } = await login(agent, email);
    const accessToken: string = body.accessToken;
    const server = app.getHttpServer();
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', `typstoria.session=${accessToken}`)
      .expect(401);
    await request(server).get(`/api/auth/me?access_token=${accessToken}`).expect(401);
    await request(server).post('/api/auth/logout').send({ accessToken }).expect(401);
    for (const value of [
      'Basic ' + accessToken,
      'Bearer',
      'Bearer malformed',
      `Bearer 2147483648.${'a'.repeat(43)}`,
      `Bearer 01.${'a'.repeat(43)}`,
      `Bearer ${randomUUID()}.${'a'.repeat(43)}`,
      'Bearer ' + accessToken + ',other',
      'Bearer ' + 'a'.repeat(600),
    ]) {
      await request(server)
        .get('/api/auth/me')
        .set('Authorization', value)
        .set('Cookie', `typstoria.session=${accessToken}`)
        .expect(401);
    }
    await request(server)
      .get('/api/auth/me')
      .set({ Authorization: [`Bearer ${accessToken}`, 'Bearer other'] })
      .expect(401);
    await request(server)
      .get('/api/auth/me')
      .set('Authorization', `bearer ${accessToken}`)
      .expect(200);
    await request(server).get('/api/auth/csrf').expect(404);
    await request(server).post('/api/auth/refresh').expect(404);
  });

  it('rejects hostile browser origins and allows Authorization preflight from the configured frontend', async () => {
    const email = account();
    await client()
      .post('/api/auth/register')
      .set('Origin', 'https://hostile.example')
      .send({ email, password })
      .expect(403);
    const preflight = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    expect(await database.getRepository(User).countBy({ normalizedEmail: email })).toBe(0);
  });

  it('rejects passwords shorter than six characters and unexpected fields, and preserves the password on duplicate registration', async () => {
    const agent = client();
    const email = account();
    await agent.post('/api/auth/register').send({ email, password: '12345' }).expect(400);
    await agent.post('/api/auth/register').send({ email, password, role: 'admin' }).expect(400);
    const first = await agent.post('/api/auth/register').send({ email, password }).expect(202);
    const duplicate = await agent
      .post('/api/auth/register')
      .send({ email: email.toUpperCase(), password: newPassword })
      .expect(202);
    expect(duplicate.body).toEqual(first.body);
    expect(emails).toHaveLength(1);
    await verify(agent);
    await login(agent, email);
    await agent.post('/api/auth/login').send({ email, password: newPassword }).expect(401);
  });

  it('resets once, revokes every old access token and rejects a racing login with the old password version', async () => {
    const first = client(),
      second = client(),
      recovery = client();
    const email = account();
    await register(first, email);
    await verify(first);
    await login(first, email);
    await login(second, email);
    const staleUser = await database
      .getRepository(User)
      .findOneByOrFail({ normalizedEmail: email });
    await recovery.post('/api/auth/forgot-password').send({ email }).expect(202);
    const resetToken = token();
    await recovery
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: '12345' })
      .expect(400);
    const results = await Promise.all(
      [1, 2].map(() =>
        recovery
          .post('/api/auth/reset-password')
          .send({ token: resetToken, password: newPassword }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    await first.get('/api/auth/me').expect(401);
    await second.get('/api/auth/me').expect(401);
    await expect(app.get(SessionService).create(staleUser, 'racing login')).rejects.toThrow(
      'Invalid email or password',
    );
    await recovery.post('/api/auth/login').send({ email, password }).expect(401);
    await login(recovery, email, newPassword);
  });

  it('keeps tokens private, omits session management routes and revokes only the token on logout', async () => {
    const first = client(),
      other = client();
    const email = account(),
      otherEmail = account();
    await register(first, email);
    await verify(first);
    await register(other, otherEmail);
    await verify(other);
    const signedIn = await login(first, email);
    await login(other, otherEmail);
    await first.get('/api/sessions').expect(404);
    await first.delete('/api/sessions/1').expect(404);
    await other.get('/api/auth/me').expect(200);
    const [id, secret] = (signedIn.body.accessToken as string).split('.') as [string, string];
    const stored = await database
      .getRepository(WebSession)
      .createQueryBuilder('session')
      .addSelect('session.secretHash')
      .where('session.id = :id', { id })
      .getOneOrFail();
    expect(stored.secretHash).toBe(hashToken(secret));
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(`${id}.${'a'.repeat(43)}`, { type: 'bearer' })
      .expect(401);
    await first.post('/api/auth/logout').expect(204);
    await first.get('/api/auth/me').expect(401);
    await other.get('/api/auth/me').expect(200);
    await other.post('/api/auth/logout').expect(204);
    await other.get('/api/auth/me').expect(401);
  });

  it('rejects expired tokens and permits a fresh login', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    await verify(agent);
    await login(agent, email);
    const user = await database.getRepository(User).findOneByOrFail({ normalizedEmail: email });
    await database
      .getRepository(WebSession)
      .update({ userId: user.id }, { expiresAt: new Date(Date.now() - 1000) });
    await agent.get('/api/auth/me').expect(401);
    await login(agent, email);
    await agent.get('/api/auth/me').expect(200);
  });

  it('rejects expired or wrong-purpose email tokens, cancels old links and enforces resend cooldown', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    const firstToken = token();
    await agent.post('/api/auth/resend-verification').send({ email }).expect(202);
    expect(emails).toHaveLength(1);
    await agent
      .post('/api/auth/reset-password')
      .send({ token: firstToken, password: newPassword })
      .expect(400);
    const user = await database.getRepository(User).findOneByOrFail({ normalizedEmail: email });
    await database
      .getRepository(IdentityChallenge)
      .update({ userId: user.id }, { createdAt: new Date(Date.now() - 240000) });
    await agent.post('/api/auth/resend-verification').send({ email }).expect(202);
    await register(agent, email);
    expect(emails).toHaveLength(1);
    await database
      .getRepository(IdentityChallenge)
      .update({ userId: user.id }, { createdAt: new Date(Date.now() - 301000) });
    await Promise.all(
      [1, 2].map(() => agent.post('/api/auth/resend-verification').send({ email }).expect(202)),
    );
    expect(emails).toHaveLength(2);
    await agent.post('/api/auth/verify-email').send({ token: firstToken }).expect(400);
    const latestToken = token();
    await database
      .getRepository(IdentityChallenge)
      .update({ userId: user.id }, { expiresAt: new Date(Date.now() - 1000) });
    await agent.post('/api/auth/verify-email').send({ token: latestToken }).expect(400);
  });

  it('applies the five-minute cooldown to password reset emails independently of verification', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    await agent.post('/api/auth/forgot-password').send({ email }).expect(202);
    expect(emails).toHaveLength(2);
    const user = await database.getRepository(User).findOneByOrFail({ normalizedEmail: email });
    const challenges = database.getRepository(IdentityChallenge);
    await challenges.update(
      { userId: user.id, kind: ChallengeKind.ResetPassword },
      { createdAt: new Date(Date.now() - 240000) },
    );
    await agent.post('/api/auth/forgot-password').send({ email }).expect(202);
    expect(emails).toHaveLength(2);
    await challenges.update(
      { userId: user.id, kind: ChallengeKind.ResetPassword },
      { createdAt: new Date(Date.now() - 301000) },
    );
    await agent.post('/api/auth/forgot-password').send({ email }).expect(202);
    expect(emails).toHaveLength(3);
  });

  it('does not let password reset replace email verification or sign the user in', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    const verification = token();
    await agent.post('/api/auth/forgot-password').send({ email }).expect(202);
    const reset = await agent
      .post('/api/auth/reset-password')
      .send({ token: token(), password: newPassword })
      .expect(200);
    expect(reset.body).not.toHaveProperty('accessToken');
    const user = await database.getRepository(User).findOneByOrFail({ normalizedEmail: email });
    expect(user.emailVerifiedAt).toBeNull();
    expect(await database.getRepository(WebSession).countBy({ userId: user.id })).toBe(0);
    await agent.post('/api/auth/login').send({ email, password }).expect(401);
    const denied = await agent
      .post('/api/auth/login')
      .send({ email, password: newPassword })
      .expect(403);
    expect(denied.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    await agent.get('/api/auth/me').expect(401);
    await agent.post('/api/auth/verify-email').send({ token: verification }).expect(200);
    await login(agent, email, newPassword);
  });

  it('does not disclose account existence or expose mail provider failures', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    const missing = await agent
      .post('/api/auth/forgot-password')
      .send({ email: 'missing@example.test' })
      .expect(202);
    mailer.send.mockRejectedValueOnce(new Error('private-provider-credentials'));
    const known = await agent.post('/api/auth/forgot-password').send({ email }).expect(202);
    expect(known.body).toEqual(missing.body);
    expect(JSON.stringify(known.body)).not.toContain('private-provider-credentials');
  });

  it('limits repeated login attempts and returns a generic error for unknown accounts', async () => {
    const agent = client();
    const email = account();
    for (let index = 0; index < 10; index++) {
      const result = await agent.post('/api/auth/login').send({ email, password }).expect(401);
      expect(result.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const limited = await agent.post('/api/auth/login').send({ email, password }).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('serializes simultaneous verification so only one request consumes the email token', async () => {
    const agent = client();
    const email = account();
    await register(agent, email);
    const verification = token();
    const results = await Promise.all(
      [1, 2].map(() => agent.post('/api/auth/verify-email').send({ token: verification })),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(
      await database
        .getRepository(IdentityChallenge)
        .countBy({ kind: ChallengeKind.VerifyEmail, tokenHash: hashToken(verification) }),
    ).toBe(1);
  });
});
