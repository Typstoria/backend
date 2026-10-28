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
import { Project } from '../../src/modules/projects/infrastructure/persistence/entities/project.entity';
import { IdempotencyRecord } from '../../src/modules/projects/infrastructure/persistence/entities/idempotency-record.entity';
import { ProjectChangesService } from '../../src/modules/projects/application/project-changes.service';
import { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { ProjectRevision } from '../../src/modules/revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../src/modules/revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { AuditEvent } from '../../src/modules/audit/infrastructure/persistence/entities/audit-event.entity';
import { MAX_TEXT_BYTES } from '../../src/modules/projects/domain/text-changes';

describe('atomic text changes with PostgreSQL and private storage', () => {
  let app: INestApplication;
  let database: DataSource;
  let storage: LocalBlobStorage;
  let root: string;
  let user: User;
  let token: string;
  let project: ProjectCreatedDto;
  const accounts: number[] = [];
  const client = () => request(app.getHttpServer());
  const create = (key: string = randomUUID()) =>
    client()
      .post('/api/projects')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ title: 'Тест змін' });
  const save = (
    operations: unknown[],
    baseRevisionId = project.revisionId,
    key: string = randomUUID(),
    projectId = project.projectId,
  ) =>
    client()
      .post(`/api/projects/${projectId}/changes`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ baseRevisionId, operations });
  const state = (revisionId?: number) =>
    client()
      .get(`/api/projects/${project.projectId}/state`)
      .query(revisionId === undefined ? {} : { revisionId })
      .auth(token, { type: 'bearer' });
  const file = (fileId: number, revisionId?: number) =>
    client()
      .get(`/api/projects/${project.projectId}/files/${fileId}`)
      .query(revisionId === undefined ? {} : { revisionId })
      .auth(token, { type: 'bearer' });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-changes-'));
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
    const email = `changes-${randomUUID()}@example.test`;
    user = await database
      .getRepository(User)
      .save({ email, normalizedEmail: email, emailVerifiedAt: new Date() });
    accounts.push(user.id);
    token = (await app.get(SessionService).create(user, 'changes-tests')).accessToken;
    project = (await create().expect(201)).body as ProjectCreatedDto;
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

  it('saves multiple files/context as one revision, preserves history, and moves files without changing their IDs', async () => {
    const result = await save([
      { type: 'updateText', fileId: project.mainFileId, content: '#invalid(' },
      { type: 'renameFile', fileId: project.mainFileId, path: 'src/original.typ' },
      { type: 'createFile', path: 'intro.typ', content: '= Вступ\nПривіт!' },
      { type: 'createFile', path: 'notes.txt', content: 'Матеріали' },
      { type: 'setEntrypoint', path: 'intro.typ' },
      { type: 'updateContext', content: 'Контекст проєкту' },
    ])
      .set('X-Request-Id', 'save-test')
      .expect(201);
    expect(result.body).toMatchObject({
      projectId: project.projectId,
      revisionNumber: 2,
      historySyncStatus: 'pending',
    });
    expect(result.body.createdFiles).toHaveLength(2);
    const introId = result.body.createdFiles.find(
      (item: { path: string }) => item.path === 'intro.typ',
    ).fileId as number;
    expect(result.body.mainFileId).toBe(introId);
    const current = await state().expect(200);
    expect(current.body).toMatchObject({
      contextText: 'Контекст проєкту',
      mainFileId: introId,
      project: { currentRevisionId: result.body.revisionId },
      revision: {
        number: 2,
        parentRevisionId: project.revisionId,
        manifestHash: result.body.manifestHash,
      },
    });
    expect(current.body.tree).toHaveLength(3);
    expect((await file(project.mainFileId).expect(200)).body).toMatchObject({
      path: 'src/original.typ',
      content: '#invalid(',
    });
    expect((await file(introId).expect(200)).body.content).toBe('= Вступ\nПривіт!');
    const historical = await state(project.revisionId).expect(200);
    expect(historical.body).toMatchObject({
      contextText: '',
      mainFileId: project.mainFileId,
      revision: { id: project.revisionId, number: 1 },
    });
    expect(historical.body.tree).toHaveLength(1);
    expect((await file(project.mainFileId, project.revisionId).expect(200)).body).toMatchObject({
      path: 'main.typ',
      content: '',
    });
    expect(
      await database
        .getRepository(AuditEvent)
        .findOneByOrFail({ projectId: project.projectId, action: 'project.saved' }),
    ).toMatchObject({ actorId: user.id, requestId: 'save-test' });

    const moved = await save(
      [
        { type: 'deleteFile', fileId: project.mainFileId },
        { type: 'renameFile', fileId: introId, path: 'chapters/intro.typ' },
      ],
      result.body.revisionId,
    ).expect(201);
    expect(moved.body).toMatchObject({ revisionNumber: 3, mainFileId: introId, createdFiles: [] });
    expect((await file(introId).expect(200)).body.path).toBe('chapters/intro.typ');
    await file(project.mainFileId).expect(404);
    await file(project.mainFileId, result.body.revisionId).expect(200);
  });

  it('replaces a deleted entrypoint with a newly created file in the same batch', async () => {
    const result = await save([
      { type: 'deleteFile', fileId: project.mainFileId },
      { type: 'setEntrypoint', path: 'new.typ' },
      { type: 'createFile', path: 'new.typ', content: '= Новий' },
    ]).expect(201);
    expect(result.body.mainFileId).toBe(result.body.createdFiles[0].fileId);
    expect((await state().expect(200)).body.tree).toHaveLength(1);
    expect(
      await database.getRepository(FileIdentity).countBy({ projectId: project.projectId }),
    ).toBe(2);
  });

  it('versions context without rewriting bytes and does not create revisions for identical-content saves', async () => {
    const put = jest.spyOn(storage, 'put');
    let accepted: ProjectCreatedDto;
    try {
      accepted = (await save([{ type: 'updateContext', content: 'Лише контекст' }]).expect(201))
        .body as ProjectCreatedDto;
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
    expect(await database.getRepository(Blob).countBy({ ownerId: user.id })).toBe(1);
    const again = await save(
      [{ type: 'updateContext', content: 'Лише контекст' }],
      accepted!.revisionId,
    ).expect(201);
    expect(again.body.manifestHash).toBe(accepted!.manifestHash);
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: project.projectId }),
    ).toBe(2);
    expect(
      await database.getRepository(ProjectSnapshot).countBy({ projectId: project.projectId }),
    ).toBe(2);
    expect(again.body).toMatchObject({
      revisionId: accepted!.revisionId,
      revisionNumber: 2,
      createdFiles: [],
    });
  });

  it('replays concurrent/lost responses before checking stale base, with canonical payload hashes', async () => {
    const key = randomUUID();
    const operations = [{ type: 'updateText', fileId: project.mainFileId, content: 'Версія 2' }];
    const results = await Promise.all(
      [1, 2, 3].map(() => save(operations, project.revisionId, key).expect(201)),
    );
    expect(results[1]!.body).toEqual(results[0]!.body);
    expect(results[2]!.body).toEqual(results[0]!.body);
    await save([{ type: 'updateContext', content: 'v3' }], results[0]!.body.revisionId).expect(201);
    const put = jest
      .spyOn(storage, 'put')
      .mockRejectedValueOnce(new Error('replay must not access storage'));
    try {
      const replay = await client()
        .post(`/api/projects/${project.projectId}/changes`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send({
          operations: [{ content: 'Версія 2', fileId: project.mainFileId, type: 'updateText' }],
          baseRevisionId: project.revisionId,
        })
        .expect(201);
      expect(replay.body).toEqual(results[0]!.body);
    } finally {
      put.mockRestore();
    }
    const conflict = await save(
      [{ ...operations[0], content: 'Інший текст' }],
      project.revisionId,
      key,
    ).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: project.projectId }),
    ).toBe(3);
  });

  it('rejects a competing base revision without losing text and lets the failed key be retried', async () => {
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      keys.map((key, index) =>
        save(
          [{ type: 'updateText', fileId: project.mainFileId, content: `Текст ${index}` }],
          project.revisionId,
          key,
        ),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const winner = results.find((result) => result.status === 201)!;
    const loserIndex = results.findIndex((result) => result.status === 409);
    expect(results[loserIndex]!.body.error).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevisionId: winner.body.revisionId },
    });
    expect((await file(project.mainFileId).expect(200)).body.content).toBe(
      `Текст ${1 - loserIndex}`,
    );
    const retry = await save(
      [{ type: 'updateText', fileId: project.mainFileId, content: 'Узгоджений текст' }],
      winner.body.revisionId,
      keys[loserIndex]!,
    ).expect(201);
    expect(retry.body.revisionNumber).toBe(3);
  });

  it('scopes idempotency to the session and route, independently of project creation', async () => {
    const key = randomUUID();
    const another = (await create(key).expect(201)).body as ProjectCreatedDto;
    const first = await save(
      [{ type: 'updateContext', content: 'A' }],
      project.revisionId,
      key,
    ).expect(201);
    const second = await save(
      [{ type: 'updateContext', content: 'B' }],
      another.revisionId,
      key,
      another.projectId,
    ).expect(201);
    expect(first.body.projectId).not.toBe(second.body.projectId);
    const nextToken = (await app.get(SessionService).create(user, 'another-session')).accessToken;
    await client()
      .post(`/api/projects/${project.projectId}/changes`)
      .auth(nextToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({
        baseRevisionId: first.body.revisionId,
        operations: [{ type: 'updateContext', content: 'C' }],
      })
      .expect(201);
  });

  it('rejects invalid final trees and paths before writing any bytes or metadata', async () => {
    const invalidBatches = [
      [{ type: 'deleteFile', fileId: project.mainFileId }],
      [{ type: 'createFile', path: 'main.typ', content: '' }],
      [{ type: 'createFile', path: 'main.typ/nested.typ', content: '' }],
      [{ type: 'renameFile', fileId: project.mainFileId, path: '../secret.typ' }],
      [{ type: 'createFile', path: '.GIT/config', content: '' }],
      [{ type: 'setEntrypoint', path: 'missing.typ' }],
      [
        { type: 'createFile', path: 'note.txt', content: '' },
        { type: 'setEntrypoint', path: 'note.txt' },
      ],
      [
        { type: 'updateText', fileId: project.mainFileId, content: 'partial' },
        { type: 'deleteFile', fileId: 2147483647 },
      ],
      [{ type: 'updateContext', content: '\0' }],
      [{ type: 'updateText', fileId: project.mainFileId, content: '\ud800' }],
    ];
    const put = jest.spyOn(storage, 'put');
    try {
      for (const operations of invalidBatches) await save(operations).expect(422);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
    expect((await file(project.mainFileId).expect(200)).body.content).toBe('');
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: project.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(FileIdentity).countBy({ projectId: project.projectId }),
    ).toBe(1);
  });

  it('validates discriminated nested DTOs, strict IDs, summary and batch limits', async () => {
    for (const operations of [
      [],
      [null],
      ['text'],
      [{ type: 'unknown' }],
      [{ type: 'updateText', content: 'x' }],
      [{ type: 'updateText', fileId: String(project.mainFileId), content: '' }],
      [{ type: 'updateText', fileId: project.mainFileId, content: '', blobId: 1 }],
      [{ type: 'createFile', path: 'x.typ' }],
      Array.from({ length: 201 }, () => ({ type: 'updateContext', content: '' })),
    ])
      await save(operations).expect(400);
    for (const body of [
      {
        baseRevisionId: String(project.revisionId),
        operations: [{ type: 'updateContext', content: '' }],
      },
      {
        baseRevisionId: project.revisionId,
        summary: null,
        operations: [{ type: 'updateContext', content: '' }],
      },
      {
        baseRevisionId: project.revisionId,
        summary: 'bad\0',
        operations: [{ type: 'updateContext', content: '' }],
      },
      {
        baseRevisionId: project.revisionId,
        ownerId: user.id,
        operations: [{ type: 'updateContext', content: '' }],
      },
    ])
      await client()
        .post(`/api/projects/${project.projectId}/changes`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(400);
    await client()
      .post(`/api/projects/${project.projectId}/changes`)
      .auth(token, { type: 'bearer' })
      .send({
        baseRevisionId: project.revisionId,
        operations: [{ type: 'updateContext', content: '' }],
      })
      .expect(400);
  });

  it('enforces UTF-8 byte limits while accepting a full 1 MiB text file through the bounded batch parser', async () => {
    const oversize = await save([
      {
        type: 'updateText',
        fileId: project.mainFileId,
        content: 'я'.repeat(MAX_TEXT_BYTES / 2 + 1),
      },
    ]).expect(413);
    expect(oversize.body.error.code).toBe('TEXT_TOO_LARGE');
    const accepted = await save([
      { type: 'updateText', fileId: project.mainFileId, content: 'x'.repeat(MAX_TEXT_BYTES) },
    ]).expect(201);
    expect((await file(project.mainFileId).expect(200)).body.sizeBytes).toBe(MAX_TEXT_BYTES);
    const tooBig = await save(
      [{ type: 'updateContext', content: 'x'.repeat(8 * MAX_TEXT_BYTES) }],
      accepted.body.revisionId,
    ).expect(413);
    expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('hides foreign projects and historical revisions and does not accept foreign file IDs', async () => {
    const email = `changes-other-${randomUUID()}@example.test`;
    const other = await database
      .getRepository(User)
      .save({ email, normalizedEmail: email, emailVerifiedAt: new Date() });
    accounts.push(other.id);
    const otherToken = (await app.get(SessionService).create(other, 'other')).accessToken;
    const otherProject = (
      await client()
        .post('/api/projects')
        .auth(otherToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Other' })
        .expect(201)
    ).body as ProjectCreatedDto;
    await save([
      { type: 'updateText', fileId: otherProject.mainFileId, content: 'foreign' },
    ]).expect(422);
    await save(
      [{ type: 'updateContext', content: '' }],
      otherProject.revisionId,
      randomUUID(),
      otherProject.projectId,
    ).expect(404);
    await state(otherProject.revisionId).expect(404);
    await file(project.mainFileId, otherProject.revisionId).expect(404);
    await client().post(`/api/projects/${project.projectId}/changes`).send({}).expect(401);
    const actor = {
      userId: user.id,
      channel: 'mcp' as const,
      credentialId: Number(token.split('.')[0]),
    };
    await expect(
      app.get(ProjectChangesService).save(
        actor,
        project.projectId,
        {
          baseRevisionId: project.revisionId,
          operations: [{ type: 'updateContext', content: '' }],
        },
        randomUUID(),
        'mcp',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not replay for a revoked session, unverified user or deleted project', async () => {
    const key = randomUUID();
    const operations = [{ type: 'updateContext', content: 'saved' }];
    await save(operations, project.revisionId, key).expect(201);
    await database.getRepository(User).update(user.id, { emailVerifiedAt: null });
    await save(operations, project.revisionId, key).expect(403);
    await database.getRepository(User).update(user.id, { emailVerifiedAt: new Date() });
    await client()
      .delete(`/api/projects/${project.projectId}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    await save(operations, project.revisionId, key).expect(404);
    await app.get(SessionService).revoke(user.id, Number(token.split('.')[0]));
    await save(operations, project.revisionId, key).expect(401);
  });

  it('rolls back the entire multi-file save on a late DB failure and retries with the same key', async () => {
    const key = randomUUID();
    const operations = [
      { type: 'updateText', fileId: project.mainFileId, content: 'changed' },
      { type: 'createFile', path: 'new.typ', content: 'new' },
    ];
    const original = EntityManager.prototype.insert;
    const insert = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      entity,
    ) {
      if (target === AuditEvent) return Promise.reject(new Error('injected late failure'));
      return original.call(this, target, entity);
    });
    try {
      await save(operations, project.revisionId, key).expect(500);
      expect(insert).toHaveBeenCalledWith(
        AuditEvent,
        expect.objectContaining({ action: 'project.saved' }),
      );
    } finally {
      insert.mockRestore();
    }
    expect(
      await database.getRepository(Project).findOneByOrFail({ id: project.projectId }),
    ).toMatchObject({ currentRevisionId: project.revisionId, nextRevisionNumber: 2 });
    expect(
      await database.getRepository(ProjectSnapshot).countBy({ projectId: project.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(FileIdentity).countBy({ projectId: project.projectId }),
    ).toBe(1);
    expect(await database.getRepository(Blob).countBy({ ownerId: user.id })).toBe(1);
    expect(
      await database.getRepository(IdempotencyRecord).countBy({ projectId: project.projectId }),
    ).toBe(1);
    expect((await save(operations, project.revisionId, key).expect(201)).body.revisionNumber).toBe(
      2,
    );
  });

  it('leaves the revision unchanged on storage failure and rechecks deletion after staging', async () => {
    const key = randomUUID();
    const operations = [{ type: 'updateText', fileId: project.mainFileId, content: 'new' }];
    const failed = jest.spyOn(storage, 'put').mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: 'File storage is unavailable',
      }),
    );
    try {
      await save(operations, project.revisionId, key).expect(503);
    } finally {
      failed.mockRestore();
    }
    expect((await state().expect(200)).body.revision.id).toBe(project.revisionId);
    const original = storage.put.bind(storage);
    const deleted = jest.spyOn(storage, 'put').mockImplementationOnce(async (ownerId, content) => {
      await client()
        .delete(`/api/projects/${project.projectId}`)
        .auth(token, { type: 'bearer' })
        .expect(204);
      return original(ownerId, content);
    });
    try {
      await save(operations, project.revisionId, key).expect(404);
    } finally {
      deleted.mockRestore();
    }
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: project.projectId }),
    ).toBe(1);
  });

  it('preserves a concurrent metadata rename when committing a document save', async () => {
    const original = storage.put.bind(storage);
    const renamed = jest.spyOn(storage, 'put').mockImplementationOnce(async (ownerId, content) => {
      await client()
        .patch(`/api/projects/${project.projectId}`)
        .auth(token, { type: 'bearer' })
        .send({ title: 'Нова назва' })
        .expect(200);
      return original(ownerId, content);
    });
    try {
      await save([{ type: 'updateText', fileId: project.mainFileId, content: 'saved' }]).expect(
        201,
      );
    } finally {
      renamed.mockRestore();
    }
    expect((await state().expect(200)).body.project).toMatchObject({
      title: 'Нова назва',
    });
  });
});
