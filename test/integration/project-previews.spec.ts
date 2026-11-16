import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { AppConfigService } from '../../src/config/app-config.service';
import { CompileProcessor } from '../../src/modules/compilation/application/compile-processor.service';
import { PreviewProcessor } from '../../src/modules/compilation/application/preview-processor.service';
import { TypstRunner, type CompileResult } from '../../src/modules/compilation/domain/compilation';
import { CompileJob } from '../../src/modules/compilation/infrastructure/persistence/entities/compile-job.entity';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { ProjectsService } from '../../src/modules/projects/application/projects.service';
import type { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { pngResource, otherPngResource } from '../fixtures/resources';
import { hasRealTypstRunner, realTypstRunner } from '../fixtures/typst-runner';

const success: CompileResult = {
  status: 'succeeded',
  errorCode: null,
  compilerFingerprint: 'a'.repeat(64),
  diagnostics: [],
  pdf: Buffer.from('%PDF-1.7\nfixture\n%%EOF'),
};
const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('private project covers', () => {
  let app: INestApplication;
  let database: DataSource;
  let compiler: CompileProcessor;
  let processor: PreviewProcessor;
  let storage: LocalBlobStorage;
  let root: string;
  let token: string;
  let project: ProjectCreatedDto;
  let accounts: number[];
  const compile = jest.fn<ReturnType<TypstRunner['compile']>, Parameters<TypstRunner['compile']>>();
  const preview = jest.fn<ReturnType<TypstRunner['preview']>, Parameters<TypstRunner['preview']>>();
  const client = () => request(app.getHttpServer());
  const state = () =>
    client().get(`/api/projects/${project.projectId}/state`).auth(token, { type: 'bearer' });
  const job = async (revisionId = project.revisionId) =>
    (
      await client()
        .post(`/api/projects/${project.projectId}/compilations`)
        .auth(token, { type: 'bearer' })
        .send({ revisionId })
        .expect(202)
    ).body as { id: number };
  const save = async () =>
    (
      await client()
        .post(`/api/projects/${project.projectId}/changes`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({
          baseRevisionId: project.revisionId,
          operations: [
            { type: 'updateText', fileId: project.mainFileId, content: '= New revision' },
          ],
        })
        .expect(201)
    ).body as ProjectCreatedDto;
  const account = async () => {
    const email = `preview-${randomUUID()}@example.test`;
    const owner = await database.manager.save(User, {
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
    });
    accounts.push(owner.id);
    return {
      owner,
      accessToken: (await app.get(SessionService).create(owner, 'preview-tests')).accessToken,
    };
  };
  const download = (accessToken = token, suffix = '') =>
    client()
      .get(`/api/projects/${project.projectId}/preview${suffix}`)
      .auth(accessToken, { type: 'bearer' });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-previews-'));
    storage = new LocalBlobStorage({ blobStoragePath: root } as AppConfigService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BlobStorage)
      .useValue(storage)
      .overrideProvider(TypstRunner)
      .useValue({ compile, preview })
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.init();
    database = app.get(DataSource);
    compiler = app.get(CompileProcessor);
    processor = app.get(PreviewProcessor);
  });
  beforeEach(async () => {
    accounts = [];
    compile.mockReset().mockResolvedValue(success);
    preview.mockReset().mockResolvedValue(pngResource);
    const created = await account();
    token = created.accessToken;
    project = (
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Preview' })
        .expect(201)
    ).body as ProjectCreatedDto;
  });
  afterEach(async () => {
    await database.manager.delete(User, { id: In(accounts) });
  });
  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('publishes a private cover without changing project files, revision or updated date', async () => {
    const before = (await state().expect(200)).body;
    expect(before.project.preview).toBeNull();
    await download().expect(404);
    const task = await job();
    await compiler.process(task.id);
    expect((await state().expect(200)).body.project.preview).toBeNull();
    await processor.process(task.id);
    const after = (await state().expect(200)).body;
    expect(after.tree).toEqual(before.tree);
    expect(after.revision.id).toBe(before.revision.id);
    expect(after.project.updatedAt).toBe(before.project.updatedAt);
    const cover = { revisionId: project.revisionId, version: version(pngResource) };
    expect(after.project.preview).toEqual(cover);
    const list = (await client().get('/api/projects').auth(token, { type: 'bearer' }).expect(200))
      .body;
    expect(list.items.find((p: { id: number }) => p.id === project.projectId).preview).toEqual(
      cover,
    );
    const image = await download(token, `?version=${cover.version}`).expect(200);
    expect(image.body).toEqual(pngResource);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toBe('no-store');
    expect(preview.mock.calls[0]![0].mainFileId).toBe(project.mainFileId);
    await download(token, `?version=${'b'.repeat(64)}`).expect(404);
    await download(token, '?version=invalid').expect(400);
    await client().get(`/api/projects/${project.projectId}/preview`).expect(401);
    const other = await account();
    await download(other.accessToken).expect(404);
    expect(JSON.stringify(list)).not.toMatch(/previewBlobId|previewJobId|storageKey|leaseToken/);
  });

  it('requires document scope and a project grant for MCP preview reads', async () => {
    const task = await job();
    await compiler.process(task.id);
    await processor.process(task.id);
    const service = app.get(ProjectsService);
    const actor = {
      userId: (await database.manager.findOneByOrFail(CompileJob, { id: task.id })).ownerId,
      channel: 'mcp' as const,
      credentialId: 1,
      projectIds: [project.projectId],
    };
    await expect(
      service.preview({ ...actor, scopes: ['projects:read'] }, project.projectId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.preview({ ...actor, scopes: ['documents:read'], projectIds: [] }, project.projectId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.preview({ ...actor, scopes: ['documents:read'] }, project.projectId),
    ).resolves.toEqual(pngResource);
  });

  it('retains the last successful cover after new saves, failed compilation and PDF expiry', async () => {
    const task = await job();
    await compiler.process(task.id);
    await processor.process(task.id);
    const next = await save();
    compile.mockResolvedValue({
      ...success,
      status: 'failed',
      errorCode: 'TYPST_ERROR',
      pdf: undefined,
    });
    const failed = await job(next.revisionId);
    await compiler.process(failed.id);
    expect(
      (await database.manager.findOneByOrFail(CompileJob, { id: failed.id })).previewStatus,
    ).toBeNull();
    await database.manager.update(CompileJob, { id: task.id }, { artifactExpiresAt: new Date(0) });
    expect((await state().expect(200)).body.project.preview.revisionId).toBe(project.revisionId);
    await download().expect(200);
  });

  it('retries preview failure independently without changing the successful PDF job', async () => {
    const old = await job();
    await compiler.process(old.id);
    await processor.process(old.id);
    const next = await save();
    const task = await job(next.revisionId);
    await compiler.process(task.id);
    preview.mockRejectedValue(new Error('Renderer unavailable'));
    for (let i = 0; i < 3; i++) {
      await database.manager.update(
        CompileJob,
        { id: task.id },
        { previewAvailableAt: new Date(0) },
      );
      await processor.process(task.id);
    }
    expect(await database.manager.findOneByOrFail(CompileJob, { id: task.id })).toMatchObject({
      status: 'succeeded',
      previewStatus: 'failed',
      previewAttempts: 3,
    });
    await client()
      .get(`/api/projects/${project.projectId}/compilations/${task.id}/pdf`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((await state().expect(200)).body.project.preview).toEqual({
      revisionId: project.revisionId,
      version: version(pngResource),
    });
  });

  it('never lets a historical revision replace a newer cover', async () => {
    const old = await job();
    await compiler.process(old.id);
    const next = await save();
    const newer = await job(next.revisionId);
    await compiler.process(newer.id);
    await processor.process(newer.id);
    preview.mockResolvedValue(otherPngResource);
    await processor.process(old.id);
    const historical = await job(project.revisionId);
    await compiler.process(historical.id);
    await processor.process(historical.id);
    expect(preview).toHaveBeenCalledTimes(1);
    expect((await state().expect(200)).body.project.preview).toEqual({
      revisionId: next.revisionId,
      version: version(pngResource),
    });
  });

  it('orders repeated compilations of the same revision by request, not completion', async () => {
    const old = await job();
    const newer = await job();
    await compiler.process(old.id);
    await compiler.process(newer.id);
    await processor.process(newer.id);
    preview.mockResolvedValue(otherPngResource);
    await processor.process(old.id);
    expect((await state().expect(200)).body.project.preview.version).toBe(version(pngResource));
  });

  it('fences a renderer that finishes after its lease was lost and retried', async () => {
    const task = await job();
    await compiler.process(task.id);
    const started = deferred<void>();
    const delayed = deferred<Buffer>();
    preview.mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const first = processor.process(task.id);
    await started.promise;
    await database.manager.update(
      CompileJob,
      { id: task.id },
      { previewLeaseExpiresAt: new Date(0) },
    );
    await processor.recoverExpired();
    preview.mockResolvedValue(otherPngResource);
    await processor.process(task.id);
    delayed.resolve(pngResource);
    await first;
    expect((await state().expect(200)).body.project.preview.version).toBe(
      version(otherPngResource),
    );
    expect(
      (await database.manager.findOneByOrFail(CompileJob, { id: task.id })).previewAttempts,
    ).toBe(2);
  });

  it('stops publishing and serving a cover when a project is deleted during rendering', async () => {
    const task = await job();
    await compiler.process(task.id);
    const started = deferred<void>();
    const delayed = deferred<Buffer>();
    preview.mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const work = processor.process(task.id);
    await started.promise;
    await client()
      .delete(`/api/projects/${project.projectId}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    delayed.resolve(pngResource);
    await work;
    expect(
      (await database.manager.findOneByOrFail(CompileJob, { id: task.id })).previewStatus,
    ).toBe('skipped');
    await download().expect(404);
  });

  it('shares owner admission limits with PDF compilation', async () => {
    const task = await job();
    await compiler.process(task.id);
    const other = await job();
    const started = deferred<void>();
    const delayed = deferred<CompileResult>();
    compile.mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const work = compiler.process(other.id);
    await started.promise;
    await processor.process(task.id);
    expect(preview).not.toHaveBeenCalled();
    delayed.resolve(success);
    await work;
    await processor.process(task.id);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  (hasRealTypstRunner ? it : it.skip)(
    'renders a two-page accepted document through the real sandbox',
    async () => {
      const next = (
        await client()
          .post(`/api/projects/${project.projectId}/changes`)
          .auth(token, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .send({
            baseRevisionId: project.revisionId,
            operations: [
              {
                type: 'updateText',
                fileId: project.mainFileId,
                content:
                  '#set page(width: 200pt, height: 300pt)\n= First page\n#pagebreak()\n= Second page',
              },
            ],
          })
          .expect(201)
      ).body;
      const runner = realTypstRunner(join(root, 'compile'));
      const realCompiler = new CompileProcessor(database, storage, runner);
      const realPreview = new PreviewProcessor(database, storage, runner, realCompiler);
      const task = await job(next.revisionId);
      await realCompiler.process(task.id);
      await realPreview.process(task.id);
      const image = await download().expect(200);
      expect(image.body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(image.body.readUInt32BE(16)).toBe(200);
      expect(image.body.readUInt32BE(20)).toBe(300);
    },
    90_000,
  );
});
