import { processQueuedCompilations } from '../../src/modules/compilation/infrastructure/process-queued-compilations';
import { AuditEvent } from '../../src/modules/audit/infrastructure/persistence/entities/audit-event.entity';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, EntityManager, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { AppConfigService } from '../../src/config/app-config.service';
import { CompilationsService } from '../../src/modules/compilation/application/compilations.service';
import { CompileProcessor } from '../../src/modules/compilation/application/compile-processor.service';
import { TypstRunner, type CompileResult } from '../../src/modules/compilation/domain/compilation';
import { CompileJob } from '../../src/modules/compilation/infrastructure/persistence/entities/compile-job.entity';
import { SandboxTypstRunner } from '../../src/modules/compilation/infrastructure/sandbox-typst-runner';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { pngResource } from '../fixtures/resources';

const pdf = Buffer.from('%PDF-1.7\nfixture one\n%%EOF');
const success = (bytes = pdf): CompileResult => ({
  status: 'succeeded',
  errorCode: null,
  compilerFingerprint: 'a'.repeat(64),
  diagnostics: [],
  pdf: bytes,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('accepted revision compilation jobs', () => {
  let app: INestApplication;
  let database: DataSource;
  let processor: CompileProcessor;
  let storage: LocalBlobStorage;
  let root: string;
  let user: User;
  let token: string;
  let project: ProjectCreatedDto;
  let accounts: number[];
  const compile = jest.fn<ReturnType<TypstRunner['compile']>, Parameters<TypstRunner['compile']>>();
  const client = () => request(app.getHttpServer());
  const create = (
    revisionId = project.revisionId,
    key: string = randomUUID(),
    projectId = project.projectId,
    accessToken = token,
  ) =>
    client()
      .post(`/api/projects/${projectId}/compilations`)
      .auth(accessToken, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ revisionId });
  const get = (id: number, projectId = project.projectId, accessToken = token) =>
    client()
      .get(`/api/projects/${projectId}/compilations/${id}`)
      .auth(accessToken, { type: 'bearer' });
  const download = (id: number, projectId = project.projectId, accessToken = token) =>
    client()
      .get(`/api/projects/${projectId}/compilations/${id}/pdf`)
      .auth(accessToken, { type: 'bearer' })
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });
  const save = (operations: unknown[], baseRevisionId = project.revisionId) =>
    client()
      .post(`/api/projects/${project.projectId}/changes`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ baseRevisionId, operations });
  const account = async () => {
    const email = `compile-${randomUUID()}@example.test`;
    const owner = await database.manager.save(User, {
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
    });
    accounts.push(owner.id);
    return {
      owner,
      accessToken: (await app.get(SessionService).create(owner, 'compile-tests')).accessToken,
    };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-compilations-'));
    storage = new LocalBlobStorage({ blobStoragePath: root } as AppConfigService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BlobStorage)
      .useValue(storage)
      .overrideProvider(TypstRunner)
      .useValue({ compile })
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.init();
    database = app.get(DataSource);
    processor = app.get(CompileProcessor);
  });
  beforeEach(async () => {
    accounts = [];
    compile.mockReset().mockResolvedValue(success());
    const created = await account();
    user = created.owner;
    token = created.accessToken;
    project = (
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Compilation' })
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

  it('stores independent compilation requests durably without changing the revision', async () => {
    const [first, second] = await Promise.all([create().expect(202), create().expect(202)]);
    expect(first.body).toMatchObject({
      status: 'queued',
      revisionId: project.revisionId,
      artifactAvailable: false,
    });
    expect(first.body.id).not.toBe(second.body.id);
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(2);
    expect(JSON.stringify(first.body)).not.toMatch(
      /storageKey|snapshotId|leaseToken|sessionId|artifactBlobId/,
    );
  });

  it('compiles exact files without context, stores a private artifact and marks old results stale', async () => {
    const next = (
      await save([
        { type: 'createFile', path: 'chapter.typ', content: '== Вступ' },
        { type: 'updateText', fileId: project.mainFileId, content: '#include "chapter.typ"' },
        { type: 'updateContext', content: 'PRIVATE CONTEXT MUST STAY OUT' },
      ]).expect(201)
    ).body;
    const job = (await create(next.revisionId).expect(202)).body;
    await processor.process(job.id);
    const input = compile.mock.calls[0]![0];
    expect(input.files.map((file) => file.path).sort()).toEqual(['chapter.typ', 'main.typ']);
    expect(input.files.map((file) => file.content.toString()).join('')).not.toContain(
      'PRIVATE CONTEXT',
    );
    expect((await get(job.id).expect(200)).body).toMatchObject({
      status: 'succeeded',
      artifactAvailable: true,
      isCurrent: true,
    });
    const result = await download(job.id).expect(200);
    expect(result.body).toEqual(pdf);
    expect(result.headers['content-type']).toBe('application/pdf');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-disposition']).toContain('attachment');
    await save(
      [{ type: 'updateText', fileId: project.mainFileId, content: 'New revision' }],
      next.revisionId,
    ).expect(201);
    expect((await get(job.id).expect(200)).body.isCurrent).toBe(false);
    expect((await download(job.id).expect(200)).body).toEqual(pdf);
  });

  it('returns Typst diagnostics as a terminal job result without reusing another PDF', async () => {
    const old = (await create().expect(202)).body;
    await processor.process(old.id);
    compile.mockResolvedValue({
      status: 'failed',
      errorCode: 'TYPST_ERROR',
      compilerFingerprint: 'a'.repeat(64),
      diagnostics: [
        {
          fileId: project.mainFileId,
          path: 'main.typ',
          severity: 'error',
          message: 'unclosed delimiter',
          range: null,
        },
      ],
    });
    const job = (await create().expect(202)).body;
    await processor.process(job.id);
    await processor.process(job.id);
    expect((await get(job.id).expect(200)).body).toMatchObject({
      status: 'failed',
      errorCode: 'TYPST_ERROR',
      artifactAvailable: false,
      diagnostics: [{ message: 'unclosed delimiter' }],
    });
    await download(job.id).expect(409);
    expect((await download(old.id).expect(200)).body).toEqual(pdf);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('claims duplicate deliveries once and serializes compilation per owner', async () => {
    const entered = deferred<void>();
    const gate = deferred<CompileResult>();
    compile.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const first = (await create().expect(202)).body;
    const second = (await create().expect(202)).body;
    const running = processor.process(first.id);
    await entered.promise;
    await Promise.all([processor.process(first.id), processor.process(second.id)]);
    expect(compile).toHaveBeenCalledTimes(1);
    expect((await get(second.id).expect(200)).body.status).toBe('queued');
    gate.resolve(success());
    await running;
    await processor.process(second.id);
    expect((await get(second.id).expect(200)).body.status).toBe('succeeded');
  });

  it('recovers a lost lease and rejects publication from its obsolete attempt', async () => {
    const entered = deferred<void>();
    const gate = deferred<CompileResult>();
    compile.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const job = (await create().expect(202)).body;
    const obsolete = processor.process(job.id);
    await entered.promise;
    await database.manager.update(
      CompileJob,
      { id: job.id },
      { leaseExpiresAt: new Date(Date.now() - 1000) },
    );
    await processor.recoverExpired();
    await processor.process(job.id);
    gate.resolve(success(Buffer.from('%PDF-1.7\nobsolete\n%%EOF')));
    await obsolete;
    expect((await download(job.id).expect(200)).body).toEqual(pdf);
    expect((await database.manager.findOneByOrFail(CompileJob, { id: job.id })).attempts).toBe(2);
  });

  it.each(['logout', 'delete'] as const)(
    'finishes after logout but cancels publication after project deletion (%s)',
    async (action) => {
      const entered = deferred<void>();
      const gate = deferred<CompileResult>();
      compile.mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      });
      const job = (await create().expect(202)).body;
      const running = processor.process(job.id);
      await entered.promise;
      if (action === 'logout')
        await app.get(SessionService).revoke(user.id, Number(token.split('.')[0]));
      else
        await client()
          .delete(`/api/projects/${project.projectId}`)
          .auth(token, { type: 'bearer' })
          .expect(204);
      gate.resolve(success());
      await running;
      expect(await database.manager.findOneByOrFail(CompileJob, { id: job.id })).toMatchObject({
        status: action === 'logout' ? 'succeeded' : 'cancelled',
        errorCode: action === 'logout' ? null : 'ACCESS_REVOKED',
      });
      await get(job.id).expect(action === 'logout' ? 401 : 404);
      await download(job.id).expect(action === 'logout' ? 401 : 404);
    },
  );

  it('bounds infrastructure retries and fails a third lost lease', async () => {
    compile.mockResolvedValue({
      status: 'failed',
      errorCode: 'RUNNER_UNAVAILABLE',
      compilerFingerprint: 'b'.repeat(64),
      diagnostics: [],
    });
    const job = (await create().expect(202)).body;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await processor.process(job.id);
      expect((await get(job.id).expect(200)).body.status).toBe(attempt < 3 ? 'queued' : 'failed');
      await database.manager.update(
        CompileJob,
        { id: job.id },
        { availableAt: new Date(Date.now() - 1000) },
      );
    }
    expect(compile).toHaveBeenCalledTimes(3);
    const lost = (await create().expect(202)).body;
    await database.manager.update(
      CompileJob,
      { id: lost.id },
      {
        status: 'running',
        attempts: 3,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    );
    await processor.recoverExpired();
    expect((await get(lost.id).expect(200)).body).toMatchObject({
      status: 'failed',
      errorCode: 'WORKER_LOST',
    });
  });

  it('isolates users and nested IDs, validates input and denies MCP direct use', async () => {
    const job = (await create().expect(202)).body;
    const other = await account();
    await get(job.id, project.projectId, other.accessToken).expect(404);
    await download(job.id, project.projectId, other.accessToken).expect(404);
    await create(project.revisionId, randomUUID(), project.projectId, other.accessToken).expect(
      404,
    );
    const otherProject = (
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Other' })
        .expect(201)
    ).body;
    await get(job.id, otherProject.projectId).expect(404);
    await create(otherProject.revisionId).expect(404);
    for (const input of [
      {},
      { revisionId: '1' },
      { revisionId: 0 },
      { revisionId: 1.5 },
      { revisionId: 2147483648 },
      { revisionId: project.revisionId, executable: 'other' },
    ])
      await client()
        .post(`/api/projects/${project.projectId}/compilations`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(input)
        .expect(400);
    await client()
      .post(`/api/projects/${project.projectId}/compilations`)
      .auth(token, { type: 'bearer' })
      .send({ revisionId: project.revisionId })
      .expect(202);
    await client().get(`/api/projects/${project.projectId}/compilations/${job.id}`).expect(401);
    await expect(
      app.get(CompilationsService).create(
        {
          userId: user.id,
          credentialId: Number(token.split('.')[0]),
          channel: 'mcp',
        },
        project.projectId,
        { revisionId: project.revisionId },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await database.manager.update(User, { id: user.id }, { emailVerifiedAt: null });
    await get(job.id).expect(403);
    await processor.process(job.id);
    expect((await database.manager.findOneByOrFail(CompileJob, { id: job.id })).status).toBe(
      'succeeded',
    );
  });

  it('enforces the pending-job quota', async () => {
    const key = randomUUID();
    await create(project.revisionId, key).expect(202);
    for (let index = 1; index < 20; index++) await create().expect(202);
    expect((await create().expect(429)).body.error.code).toBe('COMPILE_QUOTA_EXCEEDED');
    await create(project.revisionId, key).expect(429);
  });

  it('rolls back job, audit and admission admission together on a late DB failure', async () => {
    const insert = EntityManager.prototype.insert;
    const mock = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      values,
    ) {
      if (target === AuditEvent) throw new Error('fixture audit failure');
      return insert.call(this, target, values);
    });
    const key = randomUUID();
    try {
      await create(project.revisionId, key).expect(500);
    } finally {
      mock.mockRestore();
    }
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(0);
    await create(project.revisionId, key).expect(202);
  });

  it('does not publish a PDF when artifact storage fails, and exposes expiry independently of success', async () => {
    const job = (await create().expect(202)).body;
    const put = jest
      .spyOn(storage, 'put')
      .mockRejectedValueOnce(new Error('fixture storage unavailable'));
    try {
      await processor.process(job.id);
    } finally {
      put.mockRestore();
    }
    expect((await get(job.id).expect(200)).body).toMatchObject({
      status: 'queued',
      artifactAvailable: false,
    });
    await database.manager.update(
      CompileJob,
      { id: job.id },
      { availableAt: new Date(Date.now() - 1000) },
    );
    await processor.process(job.id);
    await database.manager.update(
      CompileJob,
      { id: job.id },
      { artifactExpiresAt: new Date(Date.now() - 1000) },
    );
    expect((await get(job.id).expect(200)).body).toMatchObject({
      status: 'succeeded',
      artifactAvailable: false,
    });
    await download(job.id).expect(409);
  });

  it('polls queued jobs from PostgreSQL and can resume polling after restart', async () => {
    const first = (await create().expect(202)).body;
    await processQueuedCompilations(database, processor);
    expect((await download(first.id).expect(200)).body).toEqual(pdf);
    const second = (await create().expect(202)).body;
    await processQueuedCompilations(database, processor);
    expect((await download(second.id).expect(200)).body).toEqual(pdf);
  });

  (process.env.TEST_TYPST_BINARY_PATH ? it : it.skip)(
    'compiles an uploaded resource through the real API, database worker, sandbox and private artifact storage',
    async () => {
      const runner = new SandboxTypstRunner({
        typstBinaryPath: process.env.TEST_TYPST_BINARY_PATH!,
        compileWorkPath: join(root, 'scratch'),
      } as AppConfigService);
      compile.mockImplementation((input, signal) => runner.compile(input, signal));
      const upload = await client()
        .post(`/api/projects/${project.projectId}/uploads`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .attach('file', pngResource, { filename: 'logo.png', contentType: 'image/png' })
        .expect(201);
      const revision = (
        await save([
          { type: 'attachFile', path: 'assets/logo.png', uploadId: upload.body.uploadId },
          { type: 'createFile', path: 'chapter.typ', content: '== Розділ\nУкраїнська мова.' },
          {
            type: 'updateText',
            fileId: project.mainFileId,
            content: '= Документ\n#include "chapter.typ"\n#image("assets/logo.png", width: 10pt)',
          },
        ]).expect(201)
      ).body;
      try {
        const job = (await create(revision.revisionId).expect(202)).body;
        await processQueuedCompilations(database, processor);
        const deadline = Date.now() + 10000;
        let status;
        do {
          status = (await get(job.id).expect(200)).body;
          if (!['queued', 'running'].includes(status.status)) break;
          await new Promise((done) => setTimeout(done, 50));
        } while (Date.now() < deadline);
        expect(status).toMatchObject({
          status: 'succeeded',
          isCurrent: true,
          artifactAvailable: true,
          revisionId: revision.revisionId,
        });
        const result = await download(job.id).expect(200);
        expect(result.body.subarray(0, 5).toString()).toBe('%PDF-');
        expect(result.body.length).toBeGreaterThan(1000);
      } finally {
        compile.mockReset();
      }
    },
  );
});
