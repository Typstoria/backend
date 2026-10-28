import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, EntityManager, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { AppConfigService } from '../../src/config/app-config.service';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { Blob } from '../../src/modules/files/infrastructure/persistence/entities/blob.entity';
import { FileIdentity } from '../../src/modules/files/infrastructure/persistence/entities/file-identity.entity';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { WebSession } from '../../src/modules/identity/infrastructure/persistence/entities/web-session.entity';
import { createToken, hashToken } from '../../src/modules/identity/domain/tokens';
import { Project } from '../../src/modules/projects/infrastructure/persistence/entities/project.entity';
import { IdempotencyRecord } from '../../src/modules/projects/infrastructure/persistence/entities/idempotency-record.entity';
import { ProjectsService } from '../../src/modules/projects/application/projects.service';
import { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { ProjectSnapshot } from '../../src/modules/revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { ProjectRevision } from '../../src/modules/revisions/infrastructure/persistence/entities/project-revision.entity';
import { SnapshotFile } from '../../src/modules/revisions/infrastructure/persistence/entities/snapshot-file.entity';
import { AuditEvent } from '../../src/modules/audit/infrastructure/persistence/entities/audit-event.entity';

describe('project lifecycle with PostgreSQL and private local storage', () => {
  let app: INestApplication;
  let database: DataSource;
  let root: string;
  let storage: LocalBlobStorage;
  let user: User;
  let other: User;
  let token: string;
  let otherToken: string;
  const accounts: number[] = [];
  const client = () => request(app.getHttpServer());
  const create = (key: string = randomUUID(), accessToken = token, title = 'Дипломна робота') =>
    client()
      .post('/api/projects')
      .auth(accessToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ title });
  const rename = (projectId: number, title: string, accessToken = token) =>
    client()
      .patch(`/api/projects/${projectId}`)
      .auth(accessToken, { type: 'bearer' })
      .send({ title });
  const remove = (projectId: number, accessToken = token) =>
    client().delete(`/api/projects/${projectId}`).auth(accessToken, { type: 'bearer' });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-projects-'));
    storage = new LocalBlobStorage({ blobStoragePath: root } as AppConfigService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BlobStorage)
      .useValue(storage)
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.init();
    database = app.get(DataSource);
  });

  beforeEach(async () => {
    const users = database.getRepository(User);
    const makeUser = async () => {
      const email = `projects-${randomUUID()}@example.test`;
      const result = await users.save(
        users.create({ email, normalizedEmail: email, emailVerifiedAt: new Date() }),
      );
      accounts.push(result.id);
      return result;
    };
    user = await makeUser();
    other = await makeUser();
    token = (await app.get(SessionService).create(user, 'project-tests')).accessToken;
    otherToken = (await app.get(SessionService).create(other, 'project-tests')).accessToken;
  });

  afterAll(async () => {
    try {
      if (database?.isInitialized && accounts.length)
        await database.getRepository(User).delete({ id: In(accounts) });
    } finally {
      await app?.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it('creates and reopens an owned project, empty main.typ, snapshot, revision 1, audit and pending Git mapping', async () => {
    const result = await create(randomUUID(), token, '  Дипломна робота  ')
      .set('X-Request-Id', 'project-create-test')
      .expect(201);
    const created = result.body as ProjectCreatedDto;
    expect(created).toEqual({
      projectId: expect.any(Number),
      revisionId: expect.any(Number),
      revisionNumber: 1,
      mainFileId: expect.any(Number),
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      historySyncStatus: 'pending',
    });
    expect(result.headers['cache-control']).toBe('no-store');
    const project = await database
      .getRepository(Project)
      .findOneByOrFail({ id: created.projectId, ownerId: user.id });
    expect(project).toMatchObject({
      title: 'Дипломна робота',
      currentRevisionId: created.revisionId,
      nextRevisionNumber: 2,

      deletedAt: null,
    });
    const state = await client()
      .get(`/api/projects/${project.id}/state`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(state.body).toMatchObject({
      project: { id: project.id, title: project.title, currentRevisionId: created.revisionId },
      revision: {
        id: created.revisionId,
        number: 1,
        parentRevisionId: null,
        manifestHash: created.manifestHash,
      },
      mainFileId: created.mainFileId,
      contextText: '',
    });
    expect(state.body.tree).toHaveLength(1);
    expect(state.body.tree[0]).toMatchObject({
      fileId: created.mainFileId,
      path: 'main.typ',
      contentKind: 'text',
      sizeBytes: 0,
    });
    const file = await client()
      .get(`/api/projects/${project.id}/files/${created.mainFileId}`)
      .query({ revisionId: created.revisionId })
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(file.body).toMatchObject({
      content: '',
      revisionId: created.revisionId,
      sha256: state.body.tree[0].sha256,
    });
    expect(JSON.stringify([created, state.body, file.body])).not.toMatch(
      /storageKey|storage_key|snapshotId|ownerId/,
    );

    expect(
      await database.getRepository(AuditEvent).findOneByOrFail({ projectId: project.id }),
    ).toMatchObject({
      actorId: user.id,
      action: 'project.created',
      requestId: 'project-create-test',
    });
  });

  it('serializes concurrent retries, replays the same result, and rejects a changed payload', async () => {
    const key = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => create(key).expect(201)));
    expect(results[1]!.body).toEqual(results[0]!.body);
    expect(results[2]!.body).toEqual(results[0]!.body);
    const failedStorage = jest
      .spyOn(storage, 'put')
      .mockRejectedValueOnce(new Error('storage must not be used for replay'));
    try {
      expect((await create(key).expect(201)).body).toEqual(results[0]!.body);
    } finally {
      failedStorage.mockRestore();
    }
    const conflict = await create(key, token, 'Інша назва').expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await database.getRepository(Project).countBy({ ownerId: user.id })).toBe(1);
    expect(
      await database
        .getRepository(IdempotencyRecord)
        .countBy({ projectId: results[0]!.body.projectId }),
    ).toBe(1);

    const independent = await create(key, otherToken).expect(201);
    expect(independent.body.projectId).not.toBe(results[0]!.body.projectId);
    const another = await create().expect(201);
    expect(another.body.projectId).not.toBe(results[0]!.body.projectId);
    expect(await database.getRepository(Blob).countBy({ ownerId: user.id })).toBe(1);
  });

  it('hides foreign, missing and deleted projects and checks nested file/revision IDs', async () => {
    const a = (await create().expect(201)).body as ProjectCreatedDto;
    const b = (await create(randomUUID(), otherToken).expect(201)).body as ProjectCreatedDto;
    for (const path of [
      `/api/projects/${a.projectId}`,
      `/api/projects/${a.projectId}/state`,
      `/api/projects/${a.projectId}/files/${a.mainFileId}`,
    ]) {
      const denied = await client().get(path).auth(otherToken, { type: 'bearer' }).expect(404);
      expect(denied.body.error.code).toBe('RESOURCE_NOT_FOUND');
    }
    await client()
      .get(`/api/projects/${a.projectId}/files/${b.mainFileId}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    await client()
      .get(`/api/projects/${a.projectId}/files/${a.mainFileId}`)
      .query({ revisionId: b.revisionId })
      .auth(token, { type: 'bearer' })
      .expect(404);
    await client().get('/api/projects/2147483647').auth(token, { type: 'bearer' }).expect(404);
    const key = randomUUID();
    const doomed = (await create(key).expect(201)).body as ProjectCreatedDto;
    await database.getRepository(Project).update(doomed.projectId, { deletedAt: new Date() });
    await create(key).expect(404);
    await client()
      .get(`/api/projects/${doomed.projectId}/state`)
      .auth(token, { type: 'bearer' })
      .expect(404);
  });

  it('requires a verified active Bearer session, including before replay, and disallows MCP direct creation', async () => {
    await client()
      .post('/api/projects')
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Test' })
      .expect(401);
    await database.getRepository(User).update(other.id, { emailVerifiedAt: null });
    await create(randomUUID(), otherToken).expect(403);
    const key = randomUUID();
    await create(key).expect(201);
    const sessionId = Number(token.split('.')[0]);
    await app.get(SessionService).revoke(user.id, sessionId);
    await create(key).expect(401);
    await expect(
      app.get(ProjectsService).create(
        {
          userId: user.id,
          channel: 'mcp',
          credentialId: sessionId,
        },
        'Test',
        randomUUID(),
        'test',
      ),
    ).rejects.toMatchObject({ status: 403 });
    // An unverified account cannot bypass the guard with a manually issued session either.
    const secret = createToken();
    const session = await database.getRepository(WebSession).save({
      userId: other.id,
      secretHash: hashToken(secret),
      authVersion: other.authVersion,
      userAgent: '',
      expiresAt: new Date(Date.now() + 60000),
    });
    await create(randomUUID(), `${session.id}.${secret}`).expect(403);
  });

  it('validates titles, idempotency keys and strict numeric IDs before database changes', async () => {
    for (const title of ['', '   ', 'a'.repeat(201), null, 123, 'bad\u0000title'])
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title })
        .expect(400);
    await client()
      .post('/api/projects')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Test', ownerId: other.id })
      .expect(400);
    await client()
      .post('/api/projects')
      .auth(token, { type: 'bearer' })
      .send({ title: 'Test' })
      .expect(400);
    await create('a'.repeat(129)).expect(400);
    await create('has spaces').expect(400);
    for (const id of ['0', '-1', '1e2', '1.5', '2147483648', 'abc']) {
      await client().get(`/api/projects/${id}/state`).auth(token, { type: 'bearer' }).expect(400);
      await client()
        .get('/api/projects/1/files/1')
        .query({ revisionId: id })
        .auth(token, { type: 'bearer' })
        .expect(400);
    }
    expect(await database.getRepository(Project).countBy({ ownerId: user.id })).toBe(0);
  });

  it('rolls back all relational changes after a late failure and permits retry with the same key', async () => {
    const key = randomUUID();
    const original = EntityManager.prototype.insert;
    const insert = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      entity,
    ) {
      if (target === AuditEvent) return Promise.reject(new Error('injected audit failure'));
      return original.call(this, target, entity);
    });
    try {
      await create(key).expect(500);
    } finally {
      insert.mockRestore();
    }
    expect(await database.getRepository(Project).countBy({ ownerId: user.id })).toBe(0);
    expect(await database.getRepository(Blob).countBy({ ownerId: user.id })).toBe(0);
    const result = await create(key).expect(201);
    expect(await database.getRepository(Project).countBy({ ownerId: user.id })).toBe(1);
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: result.body.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(FileIdentity).countBy({ projectId: result.body.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(ProjectSnapshot).countBy({ projectId: result.body.projectId }),
    ).toBe(1);
  });

  it('does not commit metadata when blob storage fails', async () => {
    const put = jest.spyOn(storage, 'put').mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: 'File storage is unavailable',
      }),
    );
    try {
      const response = await create().expect(503);
      expect(response.body.error.code).toBe('STORAGE_UNAVAILABLE');
    } finally {
      put.mockRestore();
    }
    expect(await database.getRepository(Project).countBy({ ownerId: user.id })).toBe(0);
  });

  it('enforces project/revision/entrypoint and tenant constraints in PostgreSQL itself', async () => {
    const a = (await create().expect(201)).body as ProjectCreatedDto;
    const b = (await create(randomUUID(), otherToken).expect(201)).body as ProjectCreatedDto;
    await expect(
      database.getRepository(Project).update(a.projectId, { currentRevisionId: b.revisionId }),
    ).rejects.toThrow();
    const revision = await database
      .getRepository(ProjectRevision)
      .findOneByOrFail({ id: a.revisionId });
    await expect(
      database
        .getRepository(ProjectSnapshot)
        .update(revision.snapshotId, { mainFileId: b.mainFileId }),
    ).rejects.toThrow();
    const otherBlob = await database.getRepository(Blob).findOneByOrFail({ ownerId: other.id });
    await expect(
      database
        .getRepository(SnapshotFile)
        .update(
          { snapshotId: revision.snapshotId, fileId: a.mainFileId },
          { blobId: otherBlob.id },
        ),
    ).rejects.toThrow();
    await expect(
      database
        .getRepository(ProjectRevision)
        .update(a.revisionId, { parentRevisionId: b.revisionId }),
    ).rejects.toThrow();
  });

  it('lists only active owned projects with default limits and stable cursor pagination', async () => {
    const empty = await client().get('/api/projects').auth(token, { type: 'bearer' }).expect(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });
    const ids: number[] = [];
    for (let index = 0; index < 21; index++) ids.push((await create().expect(201)).body.projectId);
    const foreign = (await create(randomUUID(), otherToken).expect(201)).body.projectId as number;
    const deleted = (await create().expect(201)).body.projectId as number;
    await remove(deleted).expect(204);
    const first = await client().get('/api/projects').auth(token, { type: 'bearer' }).expect(200);
    const ordered = [...ids].sort((a, b) => b - a);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.items.map((item: { id: number }) => item.id)).toEqual(ordered.slice(0, 20));
    expect(first.body.nextCursor).toBe(ordered[19]);
    expect(JSON.stringify(first.body)).not.toMatch(/ownerId|deletedAt|nextRevisionNumber/);
    const second = await client()
      .get('/api/projects')
      .query({ cursor: first.body.nextCursor })
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(second.body.items.map((item: { id: number }) => item.id)).toEqual(ordered.slice(20));
    expect(second.body.nextCursor).toBeNull();
    const full = await client()
      .get('/api/projects')
      .query({ limit: 100 })
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(full.body.items).toHaveLength(21);
    expect(full.body.nextCursor).toBeNull();

    const small = await client()
      .get('/api/projects')
      .query({ limit: 2 })
      .auth(token, { type: 'bearer' })
      .expect(200);
    const newer = (await create().expect(201)).body.projectId as number;
    await rename(ordered[2]!, 'Перейменований старіший проєкт').expect(200);
    const next = await client()
      .get('/api/projects')
      .query({ limit: 2, cursor: small.body.nextCursor })
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(next.body.items.map((item: { id: number }) => item.id)).toEqual(ordered.slice(2, 4));
    expect(next.body.items.map((item: { id: number }) => item.id)).not.toContain(newer);
    const others = await client()
      .get('/api/projects')
      .auth(otherToken, { type: 'bearer' })
      .expect(200);
    expect(others.body.items.map((item: { id: number }) => item.id)).toEqual([foreign]);
  });

  it('renames metadata without creating a document revision', async () => {
    const key = randomUUID();
    const created = (await create(key).expect(201)).body as ProjectCreatedDto;
    const before = await database.getRepository(Project).findOneByOrFail({ id: created.projectId });
    const result = await rename(created.projectId, '  Нова назва  ')
      .set('X-Request-Id', 'rename-test')
      .expect(200);
    expect(result.body).toMatchObject({
      id: created.projectId,
      title: 'Нова назва',

      currentRevisionId: created.revisionId,
      createdAt: before.createdAt.toISOString(),
    });
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: created.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(ProjectSnapshot).countBy({ projectId: created.projectId }),
    ).toBe(1);

    expect(
      await database
        .getRepository(AuditEvent)
        .findOneByOrFail({ projectId: created.projectId, action: 'project.renamed' }),
    ).toMatchObject({ actorId: user.id, requestId: 'rename-test' });
    const same = await rename(created.projectId, ' Нова назва ').expect(200);
    expect(same.body).toEqual(result.body);
    expect(
      await database
        .getRepository(AuditEvent)
        .countBy({ projectId: created.projectId, action: 'project.renamed' }),
    ).toBe(1);
    expect((await create(key).expect(201)).body).toEqual(created);
  });

  it('accepts concurrent renames and keeps the last completed title', async () => {
    const created = (await create().expect(201)).body as ProjectCreatedDto;
    const results = await Promise.all([
      rename(created.projectId, 'Назва A'),
      rename(created.projectId, 'Назва B'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 200]);
    expect(results.map((result) => result.body.title)).toEqual(['Назва A', 'Назва B']);
    const stored = await database.getRepository(Project).findOneByOrFail({ id: created.projectId });
    expect(['Назва A', 'Назва B']).toContain(stored.title);
    expect(stored).toMatchObject({
      currentRevisionId: created.revisionId,
    });
    expect(
      await database
        .getRepository(AuditEvent)
        .countBy({ projectId: created.projectId, action: 'project.renamed' }),
    ).toBe(2);
  });

  it('soft-deletes once, blocks all access and replay, and retains snapshots for deferred cleanup', async () => {
    const key = randomUUID();
    const created = (await create(key).expect(201)).body as ProjectCreatedDto;
    const deleted = await remove(created.projectId).set('X-Request-Id', 'delete-test').expect(204);
    expect(deleted.text).toBe('');
    const project = await database
      .getRepository(Project)
      .findOneByOrFail({ id: created.projectId });
    expect(project.deletedAt).toBeInstanceOf(Date);
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: created.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(ProjectSnapshot).countBy({ projectId: created.projectId }),
    ).toBe(1);
    expect(await database.getRepository(Blob).countBy({ ownerId: user.id })).toBe(1);
    for (const path of [
      `/api/projects/${created.projectId}`,
      `/api/projects/${created.projectId}/state`,
      `/api/projects/${created.projectId}/files/${created.mainFileId}?revisionId=${created.revisionId}`,
    ])
      await client().get(path).auth(token, { type: 'bearer' }).expect(404);
    await rename(created.projectId, 'Після видалення').expect(404);
    await remove(created.projectId).expect(404);
    await create(key).expect(404);
    const list = await client().get('/api/projects').auth(token, { type: 'bearer' }).expect(200);
    expect(list.body).toEqual({ items: [], nextCursor: null });
    expect(
      await database
        .getRepository(AuditEvent)
        .findOneByOrFail({ projectId: created.projectId, action: 'project.deleted' }),
    ).toMatchObject({ requestId: 'delete-test', actorId: user.id });
  });

  it('serializes rename/delete races without reviving a deleted project', async () => {
    const created = (await create().expect(201)).body as ProjectCreatedDto;
    const [renamed, deleted] = await Promise.all([
      rename(created.projectId, 'Паралельна правка'),
      remove(created.projectId),
    ]);
    expect([200, 404]).toContain(renamed.status);
    expect(deleted.status).toBe(204);
    expect(
      (await database.getRepository(Project).findOneByOrFail({ id: created.projectId })).deletedAt,
    ).toBeInstanceOf(Date);
    await client()
      .get(`/api/projects/${created.projectId}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
  });

  it('validates list and rename inputs and denies foreign projects, invalid sessions and MCP mutations', async () => {
    const created = (await create().expect(201)).body as ProjectCreatedDto;
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: '1e2' },
      { limit: '01' },
      { limit: '1.5' },
      { cursor: 0 },
      { cursor: '2147483648' },
      { cursor: '1e2' },
      { limit: [1, 2] },
      { cursor: [1, 2] },
      { ownerId: other.id },
    ])
      await client().get('/api/projects').query(query).auth(token, { type: 'bearer' }).expect(400);
    for (const body of [
      {},
      { title: ' ' },
      { title: 'Test', expectedMetadataVersion: '1' },
      { title: 'Test', expectedMetadataVersion: 0 },
      { title: 'Test', expectedMetadataVersion: 1, ownerId: other.id },
    ])
      await client()
        .patch(`/api/projects/${created.projectId}`)
        .auth(token, { type: 'bearer' })
        .send(body)
        .expect(400);
    await rename(created.projectId, 'Чужа зміна', otherToken).expect(404);
    await remove(created.projectId, otherToken).expect(404);
    await rename(2147483647, 'Відсутній').expect(404);
    await remove(2147483647).expect(404);
    await client().get('/api/projects').expect(401);
    await client().patch(`/api/projects/${created.projectId}`).send({ title: 'Test' }).expect(401);
    await client().delete(`/api/projects/${created.projectId}`).expect(401);
    await database.getRepository(User).update(other.id, { emailVerifiedAt: null });
    await client().get('/api/projects').auth(otherToken, { type: 'bearer' }).expect(403);
    await rename(created.projectId, 'Test', otherToken).expect(403);
    await remove(created.projectId, otherToken).expect(403);
    const actor = {
      userId: user.id,
      channel: 'mcp' as const,
      credentialId: Number(token.split('.')[0]),
    };
    const service = app.get(ProjectsService);
    await expect(service.list(actor, 20)).rejects.toMatchObject({ status: 403 });
    await expect(service.rename(actor, created.projectId, 'Test', 'mcp')).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.delete(actor, created.projectId, 'mcp')).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await database.getRepository(Project).findOneByOrFail({ id: created.projectId }),
    ).toMatchObject({ title: 'Дипломна робота', deletedAt: null });
  });

  it('rolls back metadata and tombstones when recording their audit fails', async () => {
    const created = (await create().expect(201)).body as ProjectCreatedDto;
    const original = EntityManager.prototype.insert;
    const insert = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      entity,
    ) {
      if (target === AuditEvent) return Promise.reject(new Error('injected audit failure'));
      return original.call(this, target, entity);
    });
    try {
      await rename(created.projectId, 'Rollback').expect(500);
      await remove(created.projectId).expect(500);
    } finally {
      insert.mockRestore();
    }
    expect(
      await database.getRepository(Project).findOneByOrFail({ id: created.projectId }),
    ).toMatchObject({ title: 'Дипломна робота', deletedAt: null });

    await rename(created.projectId, 'Повтор').expect(200);
    await remove(created.projectId).expect(204);
  });
});
