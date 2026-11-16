import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import type { UserActor } from '../../src/common/actor/actor';
import { AppConfigService } from '../../src/config/app-config.service';
import { CompilationsService } from '../../src/modules/compilation/application/compilations.service';
import { CompileProcessor } from '../../src/modules/compilation/application/compile-processor.service';
import { TypstRunner, type CompileResult } from '../../src/modules/compilation/domain/compilation';
import { CompileJob } from '../../src/modules/compilation/infrastructure/persistence/entities/compile-job.entity';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import type { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';

const pdf = Buffer.from('%PDF-1.7\nworkspace fixture\n%%EOF');
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

describe('workspace compilation', () => {
  let app: INestApplication;
  let database: DataSource;
  let processor: CompileProcessor;
  let storage: LocalBlobStorage;
  let root: string;
  let userId: number;
  let token: string;
  let project: ProjectCreatedDto;
  let accounts: number[];
  const compile = jest.fn<ReturnType<TypstRunner['compile']>, Parameters<TypstRunner['compile']>>();
  const client = () => request(app.getHttpServer());
  const latest = (projectId = project.projectId, accessToken = token) =>
    client().get(`/api/projects/${projectId}/compilations/latest-pdf`).auth(accessToken, {
      type: 'bearer',
    });
  const ensure = (projectId = project.projectId, accessToken = token) =>
    client().post(`/api/projects/${projectId}/compilations/ensure`).auth(accessToken, {
      type: 'bearer',
    });
  const create = (revisionId = project.revisionId) =>
    client()
      .post(`/api/projects/${project.projectId}/compilations`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ revisionId });
  const save = (content: string) =>
    client()
      .post(`/api/projects/${project.projectId}/changes`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({
        baseRevisionId: project.revisionId,
        operations: [{ type: 'updateText', fileId: project.mainFileId, content }],
      });
  const account = async () => {
    const email = `workspace-compile-${randomUUID()}@example.test`;
    const owner = await database.manager.save(User, {
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
    });
    accounts.push(owner.id);
    return {
      owner,
      accessToken: (await app.get(SessionService).create(owner, 'workspace-compile-tests'))
        .accessToken,
    };
  };
  const compiled = async (revisionId = project.revisionId) => {
    const job = (await create(revisionId).expect(202)).body;
    await processor.process(job.id);
    return job;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-workspace-compilation-'));
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
    token = created.accessToken;
    userId = created.owner.id;
    project = (
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Workspace compilation' })
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

  it('returns a null wrapper when there is no available accepted PDF', async () => {
    await latest().expect(200, { job: null, revisionNumber: null });
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(0);
  });

  it('creates the current server revision once, then reuses it without another queue entry', async () => {
    const [first, second] = await Promise.all([ensure().expect(200), ensure().expect(200)]);
    expect(first.body.job).toMatchObject({ status: 'queued', revisionId: project.revisionId });
    expect(second.body.job.id).toBe(first.body.job.id);
    expect(first.body.revisionNumber).toBe(1);
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(1);
    await ensure()
      .expect(200)
      .then(({ body }) => expect(body.job.id).toBe(first.body.job.id));
  });

  it('returns an existing PDF with stale currentness metadata and does not queue work', async () => {
    const job = await compiled();
    await save('A later saved revision').expect(201);
    const result = await latest().expect(200);
    expect(result.body).toMatchObject({
      revisionNumber: 1,
      job: { id: job.id, revisionId: project.revisionId, status: 'succeeded', isCurrent: false },
    });
    const ensured = await ensure().expect(200);
    expect(ensured.body.job.id).toBe(job.id);
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(1);
  });

  it('selects by accepted revision number, not by the newest historical job ID', async () => {
    const first = await compiled();
    const nextRevision = (await save('Revision two').expect(201)).body;
    const second = await compiled(nextRevision.revisionId);
    await compiled(project.revisionId); // A later manual recompilation of revision one.
    const result = await latest().expect(200);
    expect(result.body.revisionNumber).toBe(2);
    expect(result.body.job.id).toBe(second.id);
    expect(result.body.job.id).toBeGreaterThan(first.id);
  });

  it('breaks ties between successful jobs of the same revision by job ID', async () => {
    await compiled();
    const newer = await compiled();
    expect((await latest().expect(200)).body.job.id).toBe(newer.id);
  });

  it('excludes newer successful proposal PDFs from lookup and ensure', async () => {
    const accepted = await compiled();
    const proposal = (
      await client()
        .post(`/api/projects/${project.projectId}/proposals`)
        .auth(token, { type: 'bearer' })
        .send({
          baseRevisionId: project.revisionId,
          summary: 'Candidate',
          operations: [{ type: 'updateText', fileId: project.mainFileId, content: '= Candidate' }],
        })
        .expect(201)
    ).body;
    const validation = (
      await client()
        .post(`/api/projects/${project.projectId}/proposals/${proposal.id}/validate`)
        .auth(token, { type: 'bearer' })
        .send({ expectedProposalVersion: proposal.version })
        .expect(202)
    ).body;
    await processor.process(validation.compileJobId);
    expect((await latest().expect(200)).body.job.id).toBe(accepted.id);
    expect((await ensure().expect(200)).body.job.id).toBe(accepted.id);
    await database.manager.update(
      CompileJob,
      { id: accepted.id },
      { artifactExpiresAt: new Date(0) },
    );
    await latest().expect(200, { job: null, revisionNumber: null });
    const next = (await ensure().expect(200)).body.job;
    expect(next).toMatchObject({
      status: 'queued',
      revisionId: project.revisionId,
      proposalId: null,
    });
    expect(next.id).not.toBe(validation.compileJobId);
  });

  it('keeps the last available PDF after a newer head is saved and its compilation fails', async () => {
    const old = await compiled();
    const nextRevision = (await save('Broken source').expect(201)).body;
    compile.mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'TYPST_ERROR',
      compilerFingerprint: 'a'.repeat(64),
      diagnostics: [],
    });
    const failed = (await create(nextRevision.revisionId).expect(202)).body;
    await processor.process(failed.id);
    const result = await latest().expect(200);
    expect(result.body).toMatchObject({ revisionNumber: 1, job: { id: old.id, isCurrent: false } });
    expect((await ensure().expect(200)).body.job.id).toBe(old.id);
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(2);
  });

  it.each(['expired', 'missing-artifact'] as const)(
    'treats an %s PDF as unavailable and queues the current revision on ensure',
    async (condition) => {
      const old = await compiled();
      await database.manager.update(
        CompileJob,
        { id: old.id },
        condition === 'expired'
          ? { artifactExpiresAt: new Date(Date.now() - 1000) }
          : { artifactBlobId: null },
      );
      await latest().expect(200, { job: null, revisionNumber: null });
      const result = await ensure().expect(200);
      expect(result.body.job).toMatchObject({
        revisionId: project.revisionId,
        status: 'queued',
      });
      expect(result.body.job.id).not.toBe(old.id);
      expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(2);
    },
  );

  it('uses a new queued job for a newly saved server head instead of reusing older work', async () => {
    const oldHead = (await ensure().expect(200)).body.job;
    const nextRevision = (await save('Newest server head').expect(201)).body;
    const current = (await ensure().expect(200)).body.job;
    expect(current.id).not.toBe(oldHead.id);
    expect(current).toMatchObject({ status: 'queued', revisionId: nextRevision.revisionId });
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(2);
  });

  it('reuses a running job when another ensure arrives during compilation', async () => {
    const entered = deferred<void>();
    const gate = deferred<CompileResult>();
    compile.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const job = (await ensure().expect(200)).body.job;
    const processing = processor.process(job.id);
    await entered.promise;
    const duringRun = await ensure().expect(200);
    expect(duringRun.body.job).toMatchObject({ id: job.id, status: 'running' });
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(1);
    gate.resolve(success());
    await processing;
    expect((await latest().expect(200)).body.job.id).toBe(job.id);
  });

  it('allows a new explicit ensure after terminal failure without retrying failures automatically', async () => {
    compile.mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'TYPST_ERROR',
      compilerFingerprint: 'a'.repeat(64),
      diagnostics: [],
    });
    const first = (await ensure().expect(200)).body.job;
    await processor.process(first.id);
    expect((await database.manager.findOneByOrFail(CompileJob, { id: first.id })).status).toBe(
      'failed',
    );
    const second = (await ensure().expect(200)).body.job;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('queued');
    expect(await database.manager.countBy(CompileJob, { projectId: project.projectId })).toBe(2);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('requires authentication and keeps foreign and deleted projects indistinguishable', async () => {
    const other = await account();
    await client().get(`/api/projects/${project.projectId}/compilations/latest-pdf`).expect(401);
    await client().post(`/api/projects/${project.projectId}/compilations/ensure`).expect(401);
    await latest(project.projectId, other.accessToken).expect(404);
    await ensure(project.projectId, other.accessToken).expect(404);
    await client()
      .delete(`/api/projects/${project.projectId}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    await latest().expect(404);
    await ensure().expect(404);
  });

  it('enforces MCP scopes and project grants at the service boundary', async () => {
    const service = app.get(CompilationsService);
    const actor = (scopes: UserActor['scopes'], projectIds: number[]): UserActor => ({
      userId,
      credentialId: 1,
      channel: 'mcp',
      scopes,
      projectIds,
    });
    const noScope = actor([], [project.projectId]);
    const readOnly = actor(['compile:read', 'documents:read'], [project.projectId]);
    const fullScopeNoGrant = actor(['compile:read', 'compile:run', 'documents:read'], []);
    await expect(service.latestPdf(noScope, project.projectId)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.ensure(readOnly, project.projectId, randomUUID())).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.latestPdf(fullScopeNoGrant, project.projectId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.ensure(fullScopeNoGrant, project.projectId, randomUUID()),
    ).rejects.toMatchObject({
      status: 404,
    });
    const granted = {
      ...actor(['compile:read', 'compile:run', 'documents:read'], [project.projectId]),
      userId,
    };
    await expect(service.latestPdf(granted, project.projectId)).resolves.toEqual({
      job: null,
      revisionNumber: null,
    });
    await expect(service.ensure(granted, project.projectId, randomUUID())).resolves.toMatchObject({
      job: { status: 'queued', revisionId: project.revisionId },
      revisionNumber: 1,
    });
  });
});
