import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import {
  User,
  UserStatus,
} from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';

describe('PostgreSQL integration (run migrations first)', () => {
  let app: INestApplication;
  let database: DataSource;
  const email = `integration-${randomUUID()}@example.test`;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.init();
    database = app.get(DataSource);
  });

  afterAll(async () => {
    try {
      if (database?.isInitialized)
        await database.getRepository(User).delete({ normalizedEmail: email });
    } finally {
      await app?.close();
    }
  });

  it('applies all migrations, persists users and excludes password hashes from ordinary reads', async () => {
    expect(await database.showMigrations()).toBe(false);
    const users = database.getRepository(User);
    await users.insert({
      email,
      normalizedEmail: email,
      passwordHash: 'test-only-placeholder-not-a-real-password',
    });

    const user = await users.findOneByOrFail({ normalizedEmail: email });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.status).toBe(UserStatus.Active);
    expect(user.passwordHash).toBeUndefined();
    expect(user.createdAt).toBeInstanceOf(Date);

    await expect(
      users.insert({ email, normalizedEmail: email, passwordHash: 'test-only-placeholder' }),
    ).rejects.toThrow();
  });

  it('serves readiness using the real database connection', async () => {
    const result = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(result.body.checks.database).toBe('up');
  });
});
