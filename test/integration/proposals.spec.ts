import { hasRealTypstRunner, realTypstRunner } from '../fixtures/typst-runner';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, EntityManager, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { AppConfigService } from '../../src/config/app-config.service';
import { AuditEvent } from '../../src/modules/audit/infrastructure/persistence/entities/audit-event.entity';
import { CompileProcessor } from '../../src/modules/compilation/application/compile-processor.service';
import { TypstRunner, type CompileResult } from '../../src/modules/compilation/domain/compilation';
import { CompileJob } from '../../src/modules/compilation/infrastructure/persistence/entities/compile-job.entity';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { StagedUpload } from '../../src/modules/files/infrastructure/persistence/entities/staged-upload.entity';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { ProposalsService } from '../../src/modules/proposals/application/proposals.service';
import { ProposalDto, ProposalValidationDto } from '../../src/modules/proposals/http/proposals.dto';
import { Proposal } from '../../src/modules/proposals/infrastructure/persistence/entities/proposal.entity';
import { ProjectRevision } from '../../src/modules/revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../src/modules/revisions/infrastructure/persistence/entities/project-snapshot.entity';
import { pngResource } from '../fixtures/resources';

const pdf = Buffer.from('%PDF-1.7\nproposal preview\n%%EOF');
const successful = (): CompileResult => ({
  status: 'succeeded',
  errorCode: null,
  diagnostics: [],
  compilerFingerprint: 'a'.repeat(64),
  pdf,
});

describe('proposal review lifecycle', () => {
  let app: INestApplication;
  let database: DataSource;
  let processor: CompileProcessor;
  let root: string;
  let token: string;
  let user: User;
  let project: ProjectCreatedDto;
  let accounts: number[];
  const compile = jest.fn<ReturnType<TypstRunner['compile']>, Parameters<TypstRunner['compile']>>();
  const client = () => request(app.getHttpServer());
  const path = () => `/api/projects/${project.projectId}`;
  const account = async () => {
    const email = `proposal-${randomUUID()}@example.test`;
    const owner = await database.manager.save(User, {
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
    });
    accounts.push(owner.id);
    return {
      owner,
      token: (await app.get(SessionService).create(owner, 'proposal-tests')).accessToken,
    };
  };
  const operations = (content = '= Candidate') => [
    { type: 'updateText', fileId: project.mainFileId, content },
  ];
  const create = async (
    ops: unknown[] = operations(),
    baseRevisionId = project.revisionId,
  ): Promise<ProposalDto> =>
    (
      await client()
        .post(`${path()}/proposals`)
        .auth(token, { type: 'bearer' })
        .send({ baseRevisionId, summary: 'Suggested revision', operations: ops })
        .expect(201)
    ).body as ProposalDto;
  const validate = async (proposal: ProposalDto): Promise<ProposalValidationDto> =>
    (
      await client()
        .post(`${path()}/proposals/${proposal.id}/validate`)
        .auth(token, { type: 'bearer' })
        .send({ expectedProposalVersion: proposal.version })
        .expect(202)
    ).body as ProposalValidationDto;
  const validated = async (proposal: ProposalDto) => {
    const result = await validate(proposal);
    if (result.compileJobId) await processor.process(result.compileJobId);
    return result;
  };
  const acceptInput = (proposal: ProposalDto, validation: ProposalValidationDto) => ({
    baseRevisionId: proposal.baseRevisionId,
    expectedProposalVersion: proposal.version,
    validationId: validation.id,
    candidateManifestHash: proposal.candidateManifestHash,
  });
  const accept = (
    proposal: ProposalDto,
    validation: ProposalValidationDto,
    extra = {},
    key = randomUUID(),
  ) =>
    client()
      .post(`${path()}/proposals/${proposal.id}/accept`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ ...acceptInput(proposal, validation), ...extra });
  const get = (proposal: ProposalDto) =>
    client().get(`${path()}/proposals/${proposal.id}`).auth(token, { type: 'bearer' });
  const state = () => client().get(`${path()}/state`).auth(token, { type: 'bearer' });
  const save = (content = '= Manual edit') =>
    client()
      .post(`${path()}/changes`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ baseRevisionId: project.revisionId, operations: operations(content) });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-proposals-'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BlobStorage)
      .useValue(new LocalBlobStorage({ blobStoragePath: root } as AppConfigService))
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
    compile.mockReset().mockResolvedValue(successful());
    const owner = await account();
    user = owner.owner;
    token = owner.token;
    project = (
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Review' })
        .expect(201)
    ).body as ProjectCreatedDto;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await database.manager.delete(User, { id: In(accounts) });
  });
  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('keeps candidate text and new files out of the accepted document until review', async () => {
    const proposal = await create([
      ...operations(),
      { type: 'createFile', path: 'chapter.typ', content: '== New chapter' },
    ]);
    expect(proposal).toMatchObject({
      status: 'draft',
      version: 1,
      isStale: false,
      acceptedRevisionId: null,
      latestValidationId: null,
    });
    expect((await state()).body.revision.id).toBe(project.revisionId);
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      1,
    );
    const candidate = await client()
      .get(`${path()}/proposals/${proposal.id}/candidate`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const chapter = candidate.body.tree.find(
      (file: { path: string }) => file.path === 'chapter.typ',
    );
    expect(chapter).toBeDefined();
    expect(
      (
        await client()
          .get(`${path()}/proposals/${proposal.id}/files/${project.mainFileId}`)
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body.content,
    ).toBe('= Candidate');
    expect(
      (
        await client()
          .get(`${path()}/files/${project.mainFileId}`)
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body.content,
    ).toBe('');
    await client()
      .get(`${path()}/files/${chapter.fileId}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    await client()
      .get(`${path()}/state?revisionId=${proposal.candidateSnapshotId}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    const diff = await client()
      .get(`${path()}/proposals/${proposal.id}/diff`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(diff.body.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: project.mainFileId, changes: ['modified'] }),
        expect.objectContaining({ fileId: chapter.fileId, changes: ['added'] }),
      ]),
    );
  });

  it('uses the existing compile worker for an isolated candidate preview and publishes it once', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    expect(validation.status).toBe('queued');
    const job = await client()
      .get(`${path()}/compilations/${validation.compileJobId}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(job.body).toMatchObject({
      revisionId: null,
      proposalId: proposal.id,
      candidateVersion: 1,
      candidateSnapshotId: proposal.candidateSnapshotId,
      isCurrent: false,
      status: 'succeeded',
      artifactAvailable: true,
    });
    const preview = await client()
      .get(`${path()}/compilations/${validation.compileJobId}/pdf`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    const checked = await client()
      .get(`${path()}/proposals/${proposal.id}/validations/${validation.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(checked.body.status).toBe('succeeded');
    expect((await state()).body.revision.id).toBe(project.revisionId);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      accept(proposal, validation, {}, key).expect(201),
      accept(proposal, validation, {}, key).expect(201),
    ]);
    expect(a.body).toEqual(b.body);
    expect(a.body.revisionId).not.toBe(project.revisionId);
    expect((await state()).body.revision.id).toBe(a.body.revisionId);
    expect((await get(proposal)).body).toMatchObject({
      status: 'accepted',
      acceptedRevisionId: a.body.revisionId,
    });
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      2,
    );
    expect(
      await database.manager.countBy(AuditEvent, {
        projectId: project.projectId,
        action: 'proposal.accepted',
      }),
    ).toBe(1);
    const conflict = await accept(
      proposal,
      validation,
      { candidateManifestHash: 'b'.repeat(64) },
      key,
    ).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requires an exact candidate hash and validation, including when acknowledgement is true', async () => {
    const proposal = await create();
    const validation = await validate(proposal);
    expect(
      (await accept(proposal, validation, { acknowledgeCompileFailure: true }).expect(409)).body
        .error.code,
    ).toBe('VALIDATION_REQUIRED');
    await processor.process(validation.compileJobId!);
    expect(
      (await accept(proposal, validation, { candidateManifestHash: 'b'.repeat(64) }).expect(409))
        .body.error.code,
    ).toBe('CANDIDATE_CONFLICT');
    expect(
      (await accept(proposal, validation, { validationId: 2147483647 }).expect(409)).body.error
        .code,
    ).toBe('VALIDATION_REQUIRED');
    const other = await create();
    expect((await accept(other, validation).expect(409)).body.error.code).toBe(
      'VALIDATION_REQUIRED',
    );
  });

  it('versions updates, preserves old candidates, and invalidates old validation', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    const updated = (
      await client()
        .patch(`${path()}/proposals/${proposal.id}`)
        .auth(token, { type: 'bearer' })
        .send({ expectedProposalVersion: 1, operations: operations('= Revised candidate') })
        .expect(200)
    ).body as ProposalDto;
    expect(updated).toMatchObject({ version: 2, latestValidationId: null });
    expect(updated.candidateManifestHash).not.toBe(proposal.candidateManifestHash);
    expect(
      (
        await client()
          .get(`${path()}/proposals/${proposal.id}/files/${project.mainFileId}?candidateVersion=1`)
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body.content,
    ).toBe('= Candidate');
    expect(
      (
        await client()
          .get(`${path()}/proposals/${proposal.id}/files/${project.mainFileId}`)
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body.content,
    ).toBe('= Revised candidate');
    expect((await accept(proposal, validation).expect(409)).body.error.code).toBe(
      'PROPOSAL_VERSION_CONFLICT',
    );
    expect((await accept(updated, validation).expect(409)).body.error.code).toBe(
      'VALIDATION_REQUIRED',
    );
    await accept(updated, await validated(updated)).expect(201);
  });

  it('allows only one concurrent update of the same candidate version', async () => {
    const proposal = await create();
    const patch = (content: string) =>
      client()
        .patch(`${path()}/proposals/${proposal.id}`)
        .auth(token, { type: 'bearer' })
        .send({ expectedProposalVersion: 1, operations: operations(content) });
    const results = await Promise.all([patch('= First'), patch('= Second')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await get(proposal)).body.version).toBe(2);
    expect(await database.manager.countBy(ProjectSnapshot, { projectId: project.projectId })).toBe(
      3,
    );
  });

  it('refuses stale acceptance and explicitly rebases full operations onto the new base', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    const saved = await save().expect(201);
    expect((await get(proposal)).body.isStale).toBe(true);
    expect((await accept(proposal, validation).expect(409)).body.error.code).toBe(
      'REVISION_CONFLICT',
    );
    await client()
      .post(`${path()}/proposals/${proposal.id}/rebase`)
      .auth(token, { type: 'bearer' })
      .send({
        expectedProposalVersion: 1,
        baseRevisionId: project.revisionId,
        operations: operations(),
      })
      .expect(409);
    const rebased = (
      await client()
        .post(`${path()}/proposals/${proposal.id}/rebase`)
        .auth(token, { type: 'bearer' })
        .send({
          expectedProposalVersion: 1,
          baseRevisionId: saved.body.revisionId,
          operations: operations('= Manually reconciled'),
        })
        .expect(201)
    ).body as ProposalDto;
    expect(rebased).toMatchObject({
      version: 2,
      baseRevisionId: saved.body.revisionId,
      isStale: false,
      latestValidationId: null,
    });
    await accept(rebased, validation).expect(409);
    await accept(rebased, await validated(rebased)).expect(201);
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      3,
    );
  });

  it('does not silently merge two independently validated proposals', async () => {
    const first = await create(operations('= First'));
    const second = await create(operations('= Second'));
    const a = await validated(first);
    const b = await validated(second);
    await accept(first, a).expect(201);
    expect((await accept(second, b).expect(409)).body.error.code).toBe('REVISION_CONFLICT');
  });

  it('serializes acceptance with a concurrent manual save', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    const results = await Promise.all([accept(proposal, validation), save()]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      2,
    );
  });

  it('requires explicit acknowledgement of a real Typst compilation error', async () => {
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
    const proposal = await create(operations('#['));
    const validation = await validated(proposal);
    const checked = await client()
      .get(`${path()}/proposals/${proposal.id}/validations/${validation.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(checked.body).toMatchObject({ status: 'compile_failed', errorCode: 'TYPST_ERROR' });
    expect((await accept(proposal, validation).expect(409)).body.error.code).toBe(
      'COMPILE_FAILURE_ACK_REQUIRED',
    );
    await accept(proposal, validation, { acknowledgeCompileFailure: true }).expect(201);
  });

  it('never treats infrastructure failures as acknowledged Typst errors', async () => {
    compile.mockResolvedValue({
      status: 'failed',
      errorCode: 'RUNNER_UNAVAILABLE',
      compilerFingerprint: 'a'.repeat(64),
      diagnostics: [],
    });
    const proposal = await create();
    const validation = await validate(proposal);
    for (let i = 0; i < 3; i++) {
      await processor.process(validation.compileJobId!);
      if (i < 2)
        await database.manager.update(
          CompileJob,
          { id: validation.compileJobId! },
          { availableAt: new Date(0) },
        );
    }
    expect(
      (
        await client()
          .get(`${path()}/proposals/${proposal.id}/validations/${validation.id}`)
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body.status,
    ).toBe('validation_failed');
    await accept(proposal, validation, { acknowledgeCompileFailure: true }).expect(409);
    expect((await state()).body.revision.id).toBe(project.revisionId);
  });

  it('validates context-only changes without a compile job and keeps context out of Typst inputs', async () => {
    const proposal = await create([{ type: 'updateContext', content: 'Use academic Ukrainian' }]);
    const validation = await validated(proposal);
    expect(validation).toMatchObject({ status: 'not_required', compileJobId: null });
    expect(compile).not.toHaveBeenCalled();
    await accept(proposal, validation).expect(201);
    expect((await state()).body.contextText).toBe('Use academic Ukrainian');
  });

  it('accepts a no-op without inventing another content revision or Git mapping', async () => {
    const proposal = await create(operations(''));
    const accepted = await accept(proposal, await validated(proposal)).expect(201);
    expect(accepted.body.revisionId).toBe(project.revisionId);
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      1,
    );
    expect((await get(proposal)).body.status).toBe('accepted');
  });

  it('freezes staged resource bytes, even after upload expiry, without attaching to current', async () => {
    const upload = await client()
      .post(`${path()}/uploads`)
      .auth(token, { type: 'bearer' })
      .attach('file', pngResource, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    const proposal = await create([
      { type: 'attachFile', uploadId: upload.body.uploadId, path: 'assets/logo.png' },
      ...operations('#image("assets/logo.png")'),
    ]);
    await database.manager.update(
      StagedUpload,
      { id: upload.body.uploadId },
      { expiresAt: new Date(0) },
    );
    expect((await state()).body.tree).toHaveLength(1);
    const candidate = (
      await client()
        .get(`${path()}/proposals/${proposal.id}/candidate`)
        .auth(token, { type: 'bearer' })
        .expect(200)
    ).body;
    const logo = candidate.tree.find((file: { path: string }) => file.path === 'assets/logo.png');
    await client()
      .get(`${path()}/proposals/${proposal.id}/files/${logo.fileId}`)
      .auth(token, { type: 'bearer' })
      .expect(422);
    await client()
      .get(`${path()}/proposals/${proposal.id}/files/${logo.fileId}/download`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    await accept(proposal, await validated(proposal)).expect(201);
    expect(compile.mock.calls[0]![0].files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'assets/logo.png', content: pngResource }),
      ]),
    );
    expect((await state()).body.tree).toHaveLength(2);
  });

  it('rejects structural errors before publishing any candidate', async () => {
    for (const ops of [
      [{ type: 'deleteFile', fileId: project.mainFileId }],
      [{ type: 'createFile', path: '../escape.typ', content: '' }],
      [{ type: 'createFile', path: 'main.typ', content: 'duplicate' }],
    ])
      await client()
        .post(`${path()}/proposals`)
        .auth(token, { type: 'bearer' })
        .send({ baseRevisionId: project.revisionId, operations: ops })
        .expect(422);
    expect(await database.manager.countBy(Proposal, { projectId: project.projectId })).toBe(0);
    expect(await database.manager.countBy(ProjectSnapshot, { projectId: project.projectId })).toBe(
      1,
    );
  });

  it('rejects a proposal without changing the document and cancels queued previews', async () => {
    const proposal = await create();
    const validation = await validate(proposal);
    const reject = () =>
      client()
        .post(`${path()}/proposals/${proposal.id}/reject`)
        .auth(token, { type: 'bearer' })
        .send({ expectedProposalVersion: 1 });
    expect((await reject().expect(200)).body.status).toBe('rejected');
    await reject().expect(200);
    await processor.process(validation.compileJobId!);
    expect(
      (await database.manager.findOneByOrFail(CompileJob, { id: validation.compileJobId! })).status,
    ).toBe('cancelled');
    expect(compile).not.toHaveBeenCalled();
    await accept(proposal, validation).expect(409);
    await client()
      .post(`${path()}/proposals/${proposal.id}/validate`)
      .auth(token, { type: 'bearer' })
      .send({ expectedProposalVersion: 1 })
      .expect(409);
    expect((await state()).body.revision.id).toBe(project.revisionId);
  });

  it('expires drafts and prevents their queued jobs from running', async () => {
    const proposal = await create();
    const validation = await validate(proposal);
    await database.manager.update(Proposal, { id: proposal.id }, { expiresAt: new Date(0) });
    expect((await get(proposal)).body.status).toBe('expired');
    expect((await accept(proposal, validation).expect(409)).body.error.code).toBe(
      'PROPOSAL_EXPIRED',
    );
    await processor.process(validation.compileJobId!);
    expect(compile).not.toHaveBeenCalled();
  });

  it('does not publish a compile result for an outdated candidate version', async () => {
    const proposal = await create();
    const validation = await validate(proposal);
    await client()
      .patch(`${path()}/proposals/${proposal.id}`)
      .auth(token, { type: 'bearer' })
      .send({ expectedProposalVersion: 1, operations: operations('= Updated') })
      .expect(200);
    await processor.process(validation.compileJobId!);
    expect(compile).not.toHaveBeenCalled();
    expect(
      (await database.manager.findOneByOrFail(CompileJob, { id: validation.compileJobId! })).status,
    ).toBe('cancelled');
  });

  it('enforces ownership and binds nested proposal, validation and file IDs to their project', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    const other = await account();
    const urls = [
      `/proposals`,
      `/proposals/${proposal.id}`,
      `/proposals/${proposal.id}/candidate`,
      `/proposals/${proposal.id}/diff`,
      `/proposals/${proposal.id}/files/${project.mainFileId}`,
      `/proposals/${proposal.id}/validations/${validation.id}`,
      `/compilations/${validation.compileJobId}/pdf`,
    ];
    for (const suffix of urls)
      await client().get(`${path()}${suffix}`).auth(other.token, { type: 'bearer' }).expect(404);
    await client().get(`${path()}/proposals/${proposal.id}`).expect(401);
    const secondProject = (
      await client()
        .post('/api/projects')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Other own project' })
        .expect(201)
    ).body;
    await client()
      .get(`/api/projects/${secondProject.projectId}/proposals/${proposal.id}/candidate`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    await client()
      .post(`/api/projects/${secondProject.projectId}/proposals`)
      .auth(token, { type: 'bearer' })
      .send({ baseRevisionId: project.revisionId, operations: operations() })
      .expect(404);
    await client()
      .post(`${path()}/compilations`)
      .auth(token, { type: 'bearer' })
      .send({ revisionId: proposal.candidateSnapshotId })
      .expect(404);
  });

  it('forbids MCP acceptance and rejection at the application boundary', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    const service = app.get(ProposalsService);
    const actor = { userId: user.id, credentialId: 1, channel: 'mcp' as const };
    await expect(
      service.accept(
        actor,
        project.projectId,
        proposal.id,
        acceptInput(proposal, validation),
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.reject(actor, project.projectId, proposal.id, 1, randomUUID()),
    ).rejects.toMatchObject({ status: 403 });
    expect((await get(proposal)).body.status).toBe('draft');
  });

  it('rolls back acceptance, revision and outcome together when audit publication fails', async () => {
    const proposal = await create();
    const validation = await validated(proposal);
    const original = EntityManager.prototype.insert;
    const spy = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      values,
    ) {
      if (target === AuditEvent && (values as { action?: string }).action === 'proposal.accepted')
        throw new Error('Injected audit failure');
      return original.call(this, target, values);
    });
    await accept(proposal, validation).expect(500);
    spy.mockRestore();
    expect((await get(proposal)).body.status).toBe('draft');
    expect((await state()).body.revision.id).toBe(project.revisionId);
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      1,
    );
    await accept(proposal, validation).expect(201);
  });

  it('fences a running preview when its candidate is changed mid-compilation', async () => {
    let started!: () => void;
    let finish!: (result: CompileResult) => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new Promise<CompileResult>((resolve) => {
      finish = resolve;
    });
    compile.mockImplementation(async () => {
      started();
      return result;
    });
    const proposal = await create();
    const validation = await validate(proposal);
    const processing = processor.process(validation.compileJobId!);
    await entered;
    try {
      await client()
        .patch(`${path()}/proposals/${proposal.id}`)
        .auth(token, { type: 'bearer' })
        .send({ expectedProposalVersion: 1, operations: operations('= Later candidate') })
        .expect(200);
    } finally {
      finish(successful());
      await processing;
    }
    const job = await client()
      .get(`${path()}/compilations/${validation.compileJobId}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(job.body).toMatchObject({ status: 'cancelled', artifactAvailable: false });
    expect((await state()).body.revision.id).toBe(project.revisionId);
  });

  (hasRealTypstRunner ? it : it.skip)(
    'compiles a real multi-file candidate with a PNG before acceptance',
    async () => {
      const runner = realTypstRunner(join(root, 'sandbox'));
      compile.mockImplementation((input, signal) => runner.compile(input, signal));
      const upload = await client()
        .post(`${path()}/uploads`)
        .auth(token, { type: 'bearer' })
        .attach('file', pngResource, { filename: 'logo.png', contentType: 'image/png' })
        .expect(201);
      const proposal = await create([
        ...operations(
          '= Перевірка пропозиції\n#include "chapter.typ"\n#image("assets/logo.png", width: 20pt)',
        ),
        { type: 'createFile', path: 'chapter.typ', content: '== Новий розділ\nУкраїнський текст.' },
        { type: 'attachFile', path: 'assets/logo.png', uploadId: upload.body.uploadId },
      ]);
      const validation = await validated(proposal);
      const checked = await client()
        .get(`${path()}/proposals/${proposal.id}/validations/${validation.id}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(checked.body).toMatchObject({ status: 'succeeded', errorCode: null });
      await client()
        .get(`${path()}/compilations/${validation.compileJobId}/pdf`)
        .auth(token, { type: 'bearer' })
        .expect(200)
        .expect('Content-Type', /application\/pdf/);
      expect((await state()).body.tree).toHaveLength(1);
      await accept(proposal, validation).expect(201);
      expect((await state()).body.tree).toHaveLength(3);
    },
  );

  it('paginates proposals and validates malformed operation/version payloads', async () => {
    const a = await create();
    const b = await create();
    const first = await client()
      .get(`${path()}/proposals?limit=1`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(first.body.items[0].id).toBe(b.id);
    expect(first.body.nextCursor).toBe(b.id);
    const second = await client()
      .get(`${path()}/proposals?limit=1&cursor=${first.body.nextCursor}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(second.body.items[0].id).toBe(a.id);
    expect(second.body.nextCursor).toBeNull();
    await client()
      .post(`${path()}/proposals`)
      .auth(token, { type: 'bearer' })
      .send({ baseRevisionId: project.revisionId, operations: [null] })
      .expect(400);
    await client()
      .patch(`${path()}/proposals/${a.id}`)
      .auth(token, { type: 'bearer' })
      .send({ operations: operations() })
      .expect(400);
    await client()
      .get(`${path()}/proposals/${a.id}/candidate?candidateVersion=0`)
      .auth(token, { type: 'bearer' })
      .expect(400);
  });
});
