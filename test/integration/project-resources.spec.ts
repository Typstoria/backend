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
import { StagedUpload } from '../../src/modules/files/infrastructure/persistence/entities/staged-upload.entity';
import {
  MAX_ACTIVE_UPLOADS,
  MAX_RESOURCE_BYTES,
} from '../../src/modules/files/domain/resource-file';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { ProjectUploadsService } from '../../src/modules/projects/application/project-uploads.service';
import { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { ProjectUploadDto } from '../../src/modules/projects/http/project-uploads.dto';
import { ProjectRevision } from '../../src/modules/revisions/infrastructure/persistence/entities/project-revision.entity';
import { AuditEvent } from '../../src/modules/audit/infrastructure/persistence/entities/audit-event.entity';
import { pngResource, otherPngResource, pdfResource } from '../fixtures/resources';

describe('project resource staging, atomic attachment and historical downloads', () => {
  let app: INestApplication;
  let database: DataSource;
  let root: string;
  let storage: LocalBlobStorage;
  let user: User;
  let token: string;
  let project: ProjectCreatedDto;
  const accounts: number[] = [];
  const client = () => request(app.getHttpServer());
  const create = (accessToken = token) =>
    client()
      .post('/api/projects')
      .auth(accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Resources' });
  const upload = (
    content = pngResource,
    filename = 'logo.png',
    mediaType = 'image/png',
    key: string = randomUUID(),
    projectId = project.projectId,
    accessToken = token,
  ) =>
    client()
      .post(`/api/projects/${projectId}/uploads`)
      .auth(accessToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .attach('file', content, { filename, contentType: mediaType });
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
      .query(revisionId ? { revisionId } : {})
      .auth(token, { type: 'bearer' });
  const status = (uploadId: number, projectId = project.projectId, accessToken = token) =>
    client()
      .get(`/api/projects/${projectId}/uploads/${uploadId}`)
      .auth(accessToken, { type: 'bearer' });
  const download = (
    fileId: number,
    revisionId?: number,
    projectId = project.projectId,
    accessToken = token,
  ) =>
    client()
      .get(`/api/projects/${projectId}/files/${fileId}/download`)
      .query(revisionId ? { revisionId } : {})
      .auth(accessToken, { type: 'bearer' })
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-resources-'));
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
    const email = `resources-${randomUUID()}@example.test`;
    user = await database
      .getRepository(User)
      .save({ email, normalizedEmail: email, emailVerifiedAt: new Date() });
    accounts.push(user.id);
    token = (await app.get(SessionService).create(user, 'resources-tests')).accessToken;
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

  it('stages a project-bound resource without modifying the revision, and deduplicates bytes for concurrent uploads', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      [1, 2, 3].map(() => upload(pngResource, 'логотип.png', 'image/png', key).expect(201)),
    );
    expect(new Set(results.map((result) => result.body.uploadId)).size).toBe(3);
    expect(new Set(results.map((result) => result.body.sha256)).size).toBe(1);
    const staged = results[0]!.body as ProjectUploadDto;
    expect(staged).toMatchObject({
      filename: 'логотип.png',
      status: 'available',
      mediaType: 'image/png',
      sizeBytes: pngResource.length,
    });
    expect(JSON.stringify(staged)).not.toMatch(/storageKey|blobId|ownerId|sessionId/);
    expect((await status(staged.uploadId).expect(200)).body).toEqual(staged);
    expect((await state().expect(200)).body.tree).toHaveLength(1);
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: project.projectId }),
    ).toBe(1);
    expect(
      await database.getRepository(StagedUpload).countBy({ projectId: project.projectId }),
    ).toBe(3);
    expect(
      await database
        .getRepository(AuditEvent)
        .countBy({ projectId: project.projectId, action: 'project.uploaded' }),
    ).toBe(3);
    await upload(otherPngResource, 'логотип.png', 'image/png', key).expect(201);
    await client()
      .get(`/api/projects/${project.projectId}/uploads/${staged.uploadId}/download`)
      .auth(token, { type: 'bearer' })
      .expect(404);
  });

  it('atomically attaches with text edits and returns private downloads with Unicode attachment headers', async () => {
    const uploaded = (await upload(pngResource, 'логотип.png').expect(201))
      .body as ProjectUploadDto;
    const accepted = await save([
      { type: 'attachFile', uploadId: uploaded.uploadId, path: 'assets/логотип.png' },
      { type: 'updateText', fileId: project.mainFileId, content: '#image("assets/логотип.png")' },
    ]).expect(201);
    const resourceId = accepted.body.createdFiles[0].fileId as number;
    expect((await state().expect(200)).body.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: resourceId,
          contentKind: 'binary',
          mediaType: 'image/png',
          path: 'assets/логотип.png',
        }),
      ]),
    );
    expect((await status(uploaded.uploadId).expect(200)).body).toMatchObject({
      status: 'available',
    });
    const response = await download(resourceId).expect(200);
    expect(response.body).toEqual(pngResource);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('логотип.png')}`,
    );
  });

  it('reuses an upload across files and revisions without consuming it', async () => {
    const uploaded = (await upload().expect(201)).body as ProjectUploadDto;
    const first = (
      await save([{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'a.png' }]).expect(201)
    ).body;
    const second = (
      await save(
        [{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'b.png' }],
        first.revisionId,
      ).expect(201)
    ).body;
    const resourceId = second.createdFiles[0].fileId as number;
    expect((await download(resourceId).expect(200)).body).toEqual(pngResource);
    expect((await status(uploaded.uploadId).expect(200)).body.status).toBe('available');
  });

  it('replaces bytes under a stable file ID and preserves older resource revisions through rename/delete', async () => {
    const first = (await upload().expect(201)).body as ProjectUploadDto;
    const v2 = (
      await save([{ type: 'attachFile', uploadId: first.uploadId, path: 'logo.png' }]).expect(201)
    ).body;
    const resourceId = v2.createdFiles[0].fileId as number;
    const second = (await upload(otherPngResource).expect(201)).body as ProjectUploadDto;
    const v3 = (
      await save(
        [
          { type: 'replaceFile', uploadId: second.uploadId, fileId: resourceId },
          { type: 'renameFile', fileId: resourceId, path: 'assets/new-logo.png' },
        ],
        v2.revisionId,
      ).expect(201)
    ).body;
    expect(v3.createdFiles).toEqual([]);
    expect((await download(resourceId, v2.revisionId).expect(200)).body).toEqual(pngResource);
    expect((await download(resourceId, v3.revisionId).expect(200)).body).toEqual(otherPngResource);
    const removed = await save([{ type: 'deleteFile', fileId: resourceId }], v3.revisionId).expect(
      201,
    );
    await download(resourceId, removed.body.revisionId).expect(404);
    await download(resourceId, v2.revisionId).expect(200);
    await client()
      .get(`/api/projects/${project.projectId}/files/${resourceId}`)
      .query({ revisionId: v2.revisionId })
      .auth(token, { type: 'bearer' })
      .expect(400);
  });

  it('keeps MIME per snapshot when text and binary resources share identical bytes', async () => {
    const text = pdfResource.toString('utf8');
    const v2 = (await save([{ type: 'createFile', path: 'source.txt', content: text }]).expect(201))
      .body;
    const textId = v2.createdFiles[0].fileId as number;
    const uploadResult = (await upload(pdfResource, 'report.pdf', 'application/pdf').expect(201))
      .body as ProjectUploadDto;
    const v3 = (
      await save(
        [{ type: 'attachFile', uploadId: uploadResult.uploadId, path: 'report.pdf' }],
        v2.revisionId,
      ).expect(201)
    ).body;
    expect((await download(v3.createdFiles[0].fileId).expect(200)).headers['content-type']).toBe(
      'application/pdf',
    );
    expect((await download(textId, v2.revisionId).expect(200)).headers['content-type']).toMatch(
      /^text\/plain/,
    );
    expect((await state(v2.revisionId).expect(200)).body.revision.manifestHash).toBe(
      v2.manifestHash,
    );
    expect(
      await database.getRepository(Blob).countBy({ ownerId: user.id, sha256: uploadResult.sha256 }),
    ).toBe(1);
  });

  it('rejects expired uploads while replaying an already successful save', async () => {
    const expired = (await upload().expect(201)).body as ProjectUploadDto;
    await database
      .getRepository(StagedUpload)
      .update(expired.uploadId, { expiresAt: new Date(Date.now() - 1000) });
    expect((await status(expired.uploadId).expect(200)).body.status).toBe('expired');
    expect(
      (
        await save([{ type: 'attachFile', uploadId: expired.uploadId, path: 'old.png' }]).expect(
          409,
        )
      ).body.error.code,
    ).toBe('UPLOAD_EXPIRED');
    const fresh = (await upload().expect(201)).body as ProjectUploadDto;
    const key = randomUUID();
    const operations = [
      { type: 'attachFile', uploadId: fresh.uploadId, path: 'one.png' },
      { type: 'attachFile', uploadId: fresh.uploadId, path: 'two.png' },
    ];
    const accepted = (await save(operations, project.revisionId, key).expect(201)).body;
    expect(accepted.createdFiles).toHaveLength(2);
    await database
      .getRepository(StagedUpload)
      .update(fresh.uploadId, { expiresAt: new Date(Date.now() - 1000) });
    expect((await save(operations, project.revisionId, key).expect(201)).body).toEqual(accepted);
    expect(
      (
        await save(
          [{ type: 'attachFile', uploadId: fresh.uploadId, path: 'three.png' }],
          accepted.revisionId,
        ).expect(409)
      ).body.error.code,
    ).toBe('UPLOAD_EXPIRED');
    expect((await status(fresh.uploadId).expect(200)).body.status).toBe('expired');
  });

  it('keeps the upload reusable after structural errors or a late transaction failure', async () => {
    const uploaded = (await upload().expect(201)).body as ProjectUploadDto;
    await save([{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'fake.typ' }]).expect(422);
    await save([
      { type: 'replaceFile', uploadId: uploaded.uploadId, fileId: project.mainFileId },
    ]).expect(422);
    expect((await status(uploaded.uploadId).expect(200)).body.status).toBe('available');
    const original = EntityManager.prototype.insert;
    const insert = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      entity,
    ) {
      if (target === AuditEvent) return Promise.reject(new Error('late audit failure'));
      return original.call(this, target, entity);
    });
    const key = randomUUID();
    const operations = [{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'logo.png' }];
    try {
      await save(operations, project.revisionId, key).expect(500);
    } finally {
      insert.mockRestore();
    }
    expect((await status(uploaded.uploadId).expect(200)).body.status).toBe('available');
    expect((await state().expect(200)).body.revision.id).toBe(project.revisionId);
    await save(operations, project.revisionId, key).expect(201);
  });

  it('serializes competing saves of the same upload', async () => {
    const uploaded = (await upload().expect(201)).body as ProjectUploadDto;
    const results = await Promise.all([
      save([{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'a.png' }]),
      save([{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'b.png' }]),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(
      await database.getRepository(ProjectRevision).countBy({ projectId: project.projectId }),
    ).toBe(2);
  });

  it('enforces multipart cardinality, MIME/extension agreement, size and DTO limits', async () => {
    await client()
      .post(`/api/projects/${project.projectId}/uploads`)
      .auth(token, { type: 'bearer' })
      .send({})
      .expect(415);
    await client()
      .post(`/api/projects/${project.projectId}/uploads`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .field('unexpected', 'value')
      .expect(400);
    await client()
      .post(`/api/projects/${project.projectId}/uploads`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .attach('wrong', pngResource, 'logo.png')
      .expect(400);
    await client()
      .post(`/api/projects/${project.projectId}/uploads`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .attach('file', pngResource, 'logo.png')
      .attach('file', pngResource, 'other.png')
      .expect(400);
    await client()
      .post(`/api/projects/${project.projectId}/uploads`)
      .auth(token, { type: 'bearer' })
      .attach('file', pngResource, 'logo.png')
      .expect(201);
    await upload(Buffer.alloc(0)).expect(400);
    await upload(Buffer.from('<html/>')).expect(415);
    await upload(pngResource, 'logo.jpg', 'image/jpeg').expect(415);
    await upload(pngResource, 'logo.png', 'application/pdf').expect(415);
    await upload(Buffer.from('<svg/>'), 'logo.svg', 'image/svg+xml').expect(415);
    await upload(Buffer.concat([pngResource, Buffer.alloc(MAX_RESOURCE_BYTES)])).expect(413);
    await save([{ type: 'attachFile', path: 'logo.png', uploadId: '1' }]).expect(400);
    await save([{ type: 'replaceFile', uploadId: 1 }]).expect(400);
  });

  it('checks owner/project binding for upload IDs, nested revision/file IDs and downloads', async () => {
    const uploaded = (await upload().expect(201)).body as ProjectUploadDto;
    const another = (await create().expect(201)).body as ProjectCreatedDto;
    await status(uploaded.uploadId, another.projectId).expect(404);
    await save(
      [{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'logo.png' }],
      another.revisionId,
      randomUUID(),
      another.projectId,
    ).expect(404);
    const email = `resource-other-${randomUUID()}@example.test`;
    const other = await database
      .getRepository(User)
      .save({ email, normalizedEmail: email, emailVerifiedAt: new Date() });
    accounts.push(other.id);
    const otherToken = (await app.get(SessionService).create(other, 'other')).accessToken;
    await status(uploaded.uploadId, project.projectId, otherToken).expect(404);
    await upload(
      pngResource,
      'logo.png',
      'image/png',
      randomUUID(),
      project.projectId,
      otherToken,
    ).expect(404);
    const accepted = (
      await save([{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'logo.png' }]).expect(
        201,
      )
    ).body;
    const resourceId = accepted.createdFiles[0].fileId as number;
    await download(resourceId, accepted.revisionId, project.projectId, otherToken).expect(404);
    await download(resourceId, another.revisionId).expect(404);
    await download(resourceId, accepted.revisionId, another.projectId).expect(404);
    const actor = {
      userId: user.id,
      channel: 'mcp' as const,
      credentialId: Number(token.split('.')[0]),
    };
    await expect(
      app.get(ProjectUploadsService).upload(actor, project.projectId, undefined, 'mcp'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects revoked/unverified sessions and deleted projects for staging, status and historical download', async () => {
    const uploaded = (await upload().expect(201)).body as ProjectUploadDto;
    const accepted = (
      await save([{ type: 'attachFile', uploadId: uploaded.uploadId, path: 'logo.png' }]).expect(
        201,
      )
    ).body;
    const resourceId = accepted.createdFiles[0].fileId as number;
    await database.getRepository(User).update(user.id, { emailVerifiedAt: null });
    await status(uploaded.uploadId).expect(403);
    await upload().expect(403);
    await download(resourceId).expect(403);
    await database.getRepository(User).update(user.id, { emailVerifiedAt: new Date() });
    await client()
      .delete(`/api/projects/${project.projectId}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    await status(uploaded.uploadId).expect(404);
    await upload().expect(404);
    await download(resourceId, accepted.revisionId).expect(404);
    await app.get(SessionService).revoke(user.id, Number(token.split('.')[0]));
    await status(uploaded.uploadId).expect(401);
    await upload().expect(401);
    await download(resourceId).expect(401);
    await client()
      .post(`/api/projects/${project.projectId}/uploads`)
      .attach('file', pngResource, 'logo.png')
      .expect(401);
  });

  it('rechecks tombstones after storage and rolls back uploads on audit/storage failures', async () => {
    const failed = jest.spyOn(storage, 'put').mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: 'File storage is unavailable',
      }),
    );
    try {
      await upload().expect(503);
    } finally {
      failed.mockRestore();
    }
    expect(
      await database.getRepository(StagedUpload).countBy({ projectId: project.projectId }),
    ).toBe(0);
    const insertOriginal = EntityManager.prototype.insert;
    const insert = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      entity,
    ) {
      if (target === AuditEvent) return Promise.reject(new Error('upload audit failure'));
      return insertOriginal.call(this, target, entity);
    });
    const key = randomUUID();
    try {
      await upload(pngResource, 'logo.png', 'image/png', key).expect(500);
    } finally {
      insert.mockRestore();
    }
    expect(
      await database.getRepository(StagedUpload).countBy({ projectId: project.projectId }),
    ).toBe(0);
    expect(await database.getRepository(Blob).countBy({ ownerId: user.id })).toBe(1);
    await upload(pngResource, 'logo.png', 'image/png', key).expect(201);
    const original = storage.put.bind(storage);
    const deleted = jest.spyOn(storage, 'put').mockImplementationOnce(async (ownerId, content) => {
      await client()
        .delete(`/api/projects/${project.projectId}`)
        .auth(token, { type: 'bearer' })
        .expect(204);
      return original(ownerId, content);
    });
    try {
      await upload(otherPngResource).expect(404);
    } finally {
      deleted.mockRestore();
    }
    expect(
      await database.getRepository(StagedUpload).countBy({ projectId: project.projectId }),
    ).toBe(1);
  });

  it('serializes the owner upload count quota', async () => {
    const first = (await upload().expect(201)).body as ProjectUploadDto;
    const stored = await database
      .getRepository(StagedUpload)
      .findOneByOrFail({ id: first.uploadId });
    await database.getRepository(StagedUpload).insert(
      Array.from({ length: MAX_ACTIVE_UPLOADS - 2 }, () => ({
        projectId: project.projectId,
        ownerId: user.id,

        blobId: stored.blobId,
        filename: 'logo.png',
        mediaType: stored.mediaType,
        expiresAt: stored.expiresAt,
      })),
    );
    const results = await Promise.all([upload(), upload()]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 429]);
    expect(
      await database.getRepository(StagedUpload).countBy({ projectId: project.projectId }),
    ).toBe(MAX_ACTIVE_UPLOADS);
    const put = jest.spyOn(storage, 'put');
    try {
      await upload(otherPngResource).expect(429);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
  });

  it('accounts for pending bytes across projects and excludes expired staging reservations', async () => {
    const blobs = await database.getRepository(Blob).save([
      {
        ownerId: user.id,
        sha256: '1'.repeat(64),
        storageKey: 'quota-fixture-10',
        sizeBytes: MAX_RESOURCE_BYTES,
        mediaType: 'image/png',
      },
      {
        ownerId: user.id,
        sha256: '2'.repeat(64),
        storageKey: 'quota-fixture-4',
        sizeBytes: 4 * 1024 * 1024,
        mediaType: 'image/png',
      },
    ]);
    const seed = async (projectId: number) =>
      database.getRepository(StagedUpload).insert(
        Array.from({ length: 7 }, (_, index) => ({
          projectId,
          ownerId: user.id,

          blobId: blobs[index === 6 ? 1 : 0]!.id,
          filename: 'logo.png',
          mediaType: 'image/png',
          expiresAt: new Date(Date.now() + 60000),
        })),
      );
    const put = jest.spyOn(storage, 'put');
    try {
      for (let index = 0; index < 4; index++)
        await seed((await create().expect(201)).body.projectId as number);
      put.mockClear();
      await upload().expect(429);
      expect(put).not.toHaveBeenCalled();
      await database
        .getRepository(StagedUpload)
        .update({ ownerId: user.id }, { expiresAt: new Date(Date.now() - 1000) });
      await upload().expect(201);
    } finally {
      put.mockRestore();
    }
  });
});
