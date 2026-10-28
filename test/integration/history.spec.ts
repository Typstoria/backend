import { processPendingHistory } from '../../src/modules/history/infrastructure/process-pending-history';
import { AuditEvent } from '../../src/modules/audit/infrastructure/persistence/entities/audit-event.entity';
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, EntityManager, In } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { AppConfigService } from '../../src/config/app-config.service';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { GitHistoryWriter } from '../../src/modules/history/application/git-history-writer.service';
import { HistoryService } from '../../src/modules/history/application/history.service';
import { GitHistoryError, GitRepository } from '../../src/modules/history/domain/git-history';
import { LocalGitRepository } from '../../src/modules/history/infrastructure/local-git-repository';
import { GitRevisionMapping } from '../../src/modules/history/infrastructure/persistence/entities/git-revision-mapping.entity';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { ProjectRevision } from '../../src/modules/revisions/infrastructure/persistence/entities/project-revision.entity';
import { pngResource, otherPngResource } from '../fixtures/resources';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Git projection, revision history, diff and restore', () => {
  let app: INestApplication;
  let database: DataSource;
  let writer: GitHistoryWriter;
  let storage: LocalBlobStorage;
  let git: LocalGitRepository;
  let root: string;
  let user: User;
  let token: string;
  let project: ProjectCreatedDto;
  let accounts: number[];
  const client = () => request(app.getHttpServer());
  const projectPath = () => `/api/projects/${project.projectId}`;
  const repo = () => join(root, 'git', String(user.id), `${project.projectId}.git`);
  const command = (args: string[], input?: string) => {
    const result = spawnSync('/usr/bin/git', ['--git-dir', repo(), ...args], {
      input,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const createProject = (accessToken = token) =>
    client()
      .post('/api/projects')
      .auth(accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'History' });
  const save = (
    operations: unknown[],
    baseRevisionId = project.revisionId,
    key: string = randomUUID(),
  ) =>
    client()
      .post(`${projectPath()}/changes`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ baseRevisionId, operations });
  const restore = (
    targetRevisionId: number,
    expectedCurrentRevisionId: number,
    key: string = randomUUID(),
  ) =>
    client()
      .post(`${projectPath()}/restore`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ targetRevisionId, expectedCurrentRevisionId });
  const list = (query: Record<string, unknown> = {}) =>
    client().get(`${projectPath()}/revisions`).auth(token, { type: 'bearer' }).query(query);
  const detail = (id: number) =>
    client().get(`${projectPath()}/revisions/${id}`).auth(token, { type: 'bearer' });
  const diff = (to: number, from: number) =>
    client()
      .get(`${projectPath()}/revisions/${to}/diff`)
      .auth(token, { type: 'bearer' })
      .query({ against: from });
  const state = (revisionId?: number) =>
    client()
      .get(`${projectPath()}/state`)
      .auth(token, { type: 'bearer' })
      .query(revisionId ? { revisionId } : {});
  const upload = (bytes = pngResource) =>
    client()
      .post(`${projectPath()}/uploads`)
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .attach('file', bytes, { filename: 'logo.png', contentType: 'image/png' });
  const mapping = (revisionId: number) =>
    database.manager.findOneByOrFail(GitRevisionMapping, { revisionId });
  const due = async () => {
    await database.manager.update(
      GitRevisionMapping,
      { projectId: project.projectId },
      { availableAt: new Date(Date.now() - 1000) },
    );
  };
  const account = async () => {
    const email = `history-${randomUUID()}@example.test`;
    const owner = await database.manager.save(User, {
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
    });
    accounts.push(owner.id);
    return {
      owner,
      accessToken: (await app.get(SessionService).create(owner, 'history-tests')).accessToken,
    };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-history-'));
    storage = new LocalBlobStorage({ blobStoragePath: join(root, 'blobs') } as AppConfigService);
    git = new LocalGitRepository({
      gitStoragePath: join(root, 'git'),
      gitBinaryPath: '/usr/bin/git',
    } as AppConfigService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BlobStorage)
      .useValue(storage)
      .overrideProvider(GitRepository)
      .useValue(git)
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.init();
    database = app.get(DataSource);
    writer = app.get(GitHistoryWriter);
  });
  beforeEach(async () => {
    accounts = [];
    const created = await account();
    user = created.owner;
    token = created.accessToken;
    project = (await createProject().expect(201)).body as ProjectCreatedDto;
  });
  afterEach(async () => {
    await database.manager.delete(User, { id: In(accounts) });
  });
  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('lists revisions with stable pagination and returns Git status without depending on Git', async () => {
    const v2 = (
      await save([{ type: 'updateText', fileId: project.mainFileId, content: 'Version 2' }]).expect(
        201,
      )
    ).body;
    const v3 = (
      await save([{ type: 'updateContext', content: 'Context' }], v2.revisionId).expect(201)
    ).body;
    const page = (await list({ limit: 2 }).expect(200)).body;
    expect(page.items.map((item: { number: number }) => item.number)).toEqual([3, 2]);
    expect(page.nextCursor).toBe(2);
    expect(
      (await list({ limit: 2, cursor: page.nextCursor }).expect(200)).body.items.map(
        (item: { number: number }) => item.number,
      ),
    ).toEqual([1]);
    expect(page.items[0]).toMatchObject({
      id: v3.revisionId,
      isCurrent: true,
      historySyncStatus: 'pending',
      commitSha: null,
      channel: 'web',
      operation: 'save',
      actorId: user.id,
    });
    expect(Number.isNaN(Date.parse(page.items[0].createdAt))).toBe(false);
    expect((await list().expect(200)).body.nextCursor).toBeNull();
    await list({ limit: 100 }).expect(200);
    for (const query of [
      { limit: 101 },
      { limit: '1e2' },
      { cursor: '01' },
      { cursor: ['1', '2'] },
      { unknown: 1 },
    ])
      await list(query).expect(400);
    await writer.process(project.projectId);
    expect((await detail(v2.revisionId).expect(200)).body).toMatchObject({
      historySyncStatus: 'ready',
      isCurrent: false,
      commitSha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect((await state().expect(200)).body.revision.historySyncStatus).toBe('ready');
    expect(JSON.stringify((await detail(v3.revisionId).expect(200)).body)).not.toMatch(
      /storageKey|leaseToken|snapshotId|\.git/,
    );
  });

  it('compares snapshots by file ID including rename, text, binary, context and entrypoint', async () => {
    const resource = (await upload().expect(201)).body;
    const v2 = (
      await save([
        { type: 'renameFile', fileId: project.mainFileId, path: 'src/main.typ' },
        { type: 'updateText', fileId: project.mainFileId, content: '= Оновлений документ\n' },
        { type: 'createFile', path: 'chapter.typ', content: '== Вступ\n' },
        { type: 'attachFile', path: 'assets/логотип.png', uploadId: resource.uploadId },
        { type: 'setEntrypoint', path: 'chapter.typ' },
        { type: 'updateContext', content: 'Новий контекст' },
      ]).expect(201)
    ).body;
    const result = (await diff(v2.revisionId, project.revisionId).expect(200)).body;
    expect(result).toMatchObject({
      fromHistorySyncStatus: 'pending',
      toHistorySyncStatus: 'pending',
      entrypoint: { changed: true },
      context: { changed: true, patch: expect.stringContaining('+Новий контекст') },
    });
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: project.mainFileId,
          changes: ['renamed', 'modified'],
          patch: expect.stringContaining('+= Оновлений документ'),
        }),
        expect.objectContaining({
          changes: ['added'],
          after: expect.objectContaining({ path: 'assets/логотип.png' }),
          patch: null,
          patchOmittedReason: 'BINARY',
        }),
        expect.objectContaining({
          changes: ['added'],
          patch: expect.stringContaining('+== Вступ'),
        }),
      ]),
    );
    const binaryId = v2.createdFiles.find((file: { path: string }) => file.path.endsWith('.png'))
      .fileId as number;
    const replacement = (await upload(otherPngResource).expect(201)).body;
    const v3 = (
      await save(
        [
          { type: 'replaceFile', fileId: binaryId, uploadId: replacement.uploadId },
          { type: 'renameFile', fileId: binaryId, path: 'new-logo.png' },
        ],
        v2.revisionId,
      ).expect(201)
    ).body;
    expect((await diff(v3.revisionId, v2.revisionId).expect(200)).body.files).toEqual([
      expect.objectContaining({
        fileId: binaryId,
        changes: ['renamed', 'modified'],
        patchOmittedReason: 'BINARY',
        before: expect.objectContaining({ sha256: resource.sha256 }),
        after: expect.objectContaining({ sha256: replacement.sha256 }),
      }),
    ]);
  });

  it('bounds patch work, exposes omitted large text and avoids storage reads for unchanged or renamed bytes', async () => {
    const operations: unknown[] = Array.from({ length: 25 }, (_, index) => ({
      type: 'createFile',
      path: `${index}.txt`,
      content: `Text ${index}\n`,
    }));
    operations.push({ type: 'createFile', path: 'large.txt', content: 'a'.repeat(130 * 1024) });
    const next = (await save(operations).expect(201)).body;
    const result = (await diff(next.revisionId, project.revisionId).expect(200)).body;
    expect(result.files).toHaveLength(26);
    expect(
      result.files.filter((file: { patch: string | null }) => file.patch).length,
    ).toBeLessThanOrEqual(20);
    expect(
      result.files.some(
        (file: { patchOmittedReason: string }) => file.patchOmittedReason === 'PATCH_LIMIT',
      ),
    ).toBe(true);
    expect(
      result.files.some(
        (file: { patchOmittedReason: string }) => file.patchOmittedReason === 'TEXT_TOO_LARGE',
      ),
    ).toBe(true);
    const renamed = (
      await save(
        [{ type: 'renameFile', fileId: project.mainFileId, path: 'renamed.typ' }],
        next.revisionId,
      ).expect(201)
    ).body;
    const read = jest.spyOn(storage, 'read');
    try {
      expect((await diff(renamed.revisionId, renamed.revisionId).expect(200)).body.files).toEqual(
        [],
      );
      expect(
        (await diff(renamed.revisionId, next.revisionId).expect(200)).body.files[0],
      ).toMatchObject({ changes: ['renamed'], patch: null });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('restores an immutable snapshot as a new revision with stable IDs and no blob I/O', async () => {
    const resource = (await upload().expect(201)).body;
    const v2 = (
      await save([
        { type: 'createFile', path: 'chapter.typ', content: '== Chapter' },
        { type: 'attachFile', path: 'logo.png', uploadId: resource.uploadId },
        { type: 'setEntrypoint', path: 'chapter.typ' },
        { type: 'updateContext', content: 'Context to restore' },
      ]).expect(201)
    ).body;
    const v3 = (
      await save(
        [
          { type: 'deleteFile', fileId: v2.createdFiles[0].fileId },
          { type: 'deleteFile', fileId: v2.createdFiles[1].fileId },
          { type: 'setEntrypoint', path: 'main.typ' },
          { type: 'updateText', fileId: project.mainFileId, content: 'Changed' },
          { type: 'updateContext', content: 'Later context' },
        ],
        v2.revisionId,
      ).expect(201)
    ).body;
    const getBytes = jest
      .spyOn(storage, 'read')
      .mockRejectedValue(new Error('fixture storage unavailable'));
    const put = jest
      .spyOn(storage, 'put')
      .mockRejectedValue(new Error('fixture storage unavailable'));
    let restored;
    try {
      restored = (await restore(v2.revisionId, v3.revisionId).expect(201)).body;
      expect(getBytes).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    } finally {
      getBytes.mockRestore();
      put.mockRestore();
    }
    expect(restored).toMatchObject({
      revisionNumber: 4,
      restoredFromRevisionId: v2.revisionId,
      manifestHash: v2.manifestHash,
      mainFileId: v2.mainFileId,
    });
    const old = (await state(v2.revisionId).expect(200)).body;
    const current = (await state().expect(200)).body;
    expect(current.tree).toEqual(old.tree);
    expect(current.contextText).toBe(old.contextText);
    expect(current.mainFileId).toBe(old.mainFileId);
    expect(current.revision.parentRevisionId).toBe(v3.revisionId);
    expect((await detail(restored.revisionId).expect(200)).body.operation).toBe('restore');
    expect((await list().expect(200)).body.items).toHaveLength(4);
  });

  it('replays restore before stale checks and rejects competing saves/restores atomically', async () => {
    const v2 = (
      await save([{ type: 'updateText', fileId: project.mainFileId, content: 'v2' }]).expect(201)
    ).body;
    const key = randomUUID();
    const accepted = await Promise.all([
      restore(project.revisionId, v2.revisionId, key).expect(201),
      restore(project.revisionId, v2.revisionId, key).expect(201),
    ]);
    expect(accepted[1]!.body).toEqual(accepted[0]!.body);
    expect(
      (await restore(v2.revisionId, accepted[0]!.body.revisionId, key).expect(409)).body.error.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    const current = accepted[0]!.body.revisionId as number;
    const race = await Promise.all([
      restore(v2.revisionId, current),
      save([{ type: 'updateContext', content: 'Concurrent' }], current),
    ]);
    expect(race.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await restore(project.revisionId, v2.revisionId, key).expect(201)).body).toEqual(
      accepted[0]!.body,
    );
    expect((await list().expect(200)).body.items).toHaveLength(4);
  });

  it('rolls back restore, current pointer, mapping and idempotency on a late audit failure', async () => {
    const next = (await save([{ type: 'updateContext', content: 'New' }]).expect(201)).body;
    const key = randomUUID();
    const insert = EntityManager.prototype.insert;
    const failure = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(function (
      this: EntityManager,
      target,
      values,
    ) {
      if (target === AuditEvent) throw new Error('fixture audit failure');
      return insert.call(this, target, values);
    });
    try {
      await restore(project.revisionId, next.revisionId, key).expect(500);
    } finally {
      failure.mockRestore();
    }
    expect((await state().expect(200)).body.revision.id).toBe(next.revisionId);
    expect(
      await database.manager.countBy(GitRevisionMapping, { projectId: project.projectId }),
    ).toBe(2);
    expect(await database.manager.countBy(ProjectRevision, { projectId: project.projectId })).toBe(
      2,
    );
    await restore(project.revisionId, next.revisionId, key).expect(201);
  });

  it('writes deterministic real Git commits, exact resource bytes and the canonical manifest in order', async () => {
    const resource = (await upload().expect(201)).body;
    const next = (
      await save([
        { type: 'attachFile', uploadId: resource.uploadId, path: 'assets/логотип.png' },
        { type: 'updateText', fileId: project.mainFileId, content: '= Документ\n' },
        { type: 'updateContext', content: 'PRIVATE CONTEXT' },
      ]).expect(201)
    ).body;
    await writer.process(project.projectId);
    const first = await mapping(project.revisionId);
    const second = await mapping(next.revisionId);
    expect(first.status).toBe('ready');
    expect(second).toMatchObject({ status: 'ready', parentSha: first.commitSha });
    expect(command(['rev-list', '--count', 'refs/heads/main'])).toBe('2');
    expect(command(['show', `${second.commitSha}:main.typ`])).toBe('= Документ');
    const binary = spawnSync('/usr/bin/git', [
      '--git-dir',
      repo(),
      'show',
      `${second.commitSha}:assets/логотип.png`,
    ]);
    expect(binary.stdout).toEqual(pngResource);
    const manifest = command(['show', `${second.commitSha}:.typstoria/manifest.json`]);
    expect(createHash('sha256').update(manifest).digest('hex')).toBe(next.manifestHash);
    expect(JSON.parse(manifest)).toMatchObject({
      mainFileId: project.mainFileId,
      contextText: 'PRIVATE CONTEXT',
      files: expect.arrayContaining([expect.objectContaining({ fileId: project.mainFileId })]),
    });
    expect(command(['show', '-s', '--format=%an <%ae>', second.commitSha!])).toBe(
      `User ${user.id} <user-${user.id}@typstoria.invalid>`,
    );
    await writer.process(project.projectId);
    expect((await mapping(next.revisionId)).commitSha).toBe(second.commitSha);
    expect(command(['rev-list', '--count', 'refs/heads/main'])).toBe('2');
  });

  it('recovers after Git ref publication succeeds but the mapping transaction fails', async () => {
    const next = (await save([{ type: 'updateContext', content: 'v2' }]).expect(201)).body;
    const update = EntityManager.prototype.update;
    let injected = false;
    const failure = jest.spyOn(EntityManager.prototype, 'update').mockImplementation(function (
      this: EntityManager,
      target,
      criteria,
      values,
    ) {
      if (
        !injected &&
        target === GitRevisionMapping &&
        (values as { status?: string }).status === 'ready'
      ) {
        injected = true;
        throw new Error('fixture publication failure');
      }
      return update.call(this, target, criteria, values);
    });
    try {
      await writer.process(project.projectId);
    } finally {
      failure.mockRestore();
    }
    const sha = command(['rev-parse', 'refs/heads/main']);
    expect((await mapping(project.revisionId)).status).toBe('failed');
    await due();
    await writer.process(project.projectId);
    expect((await mapping(project.revisionId)).commitSha).toBe(sha);
    expect((await mapping(next.revisionId)).parentSha).toBe(sha);
    expect(command(['rev-list', '--count', 'refs/heads/main'])).toBe('2');
  });

  it('serializes concurrent project deliveries and releases the lock after completion', async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const write = git.write.bind(git);
    const spy = jest.spyOn(git, 'write').mockImplementationOnce(async (input, signal) => {
      entered.resolve();
      await gate.promise;
      return write(input, signal);
    });
    try {
      const processing = writer.process(project.projectId);
      await entered.promise;
      await writer.process(project.projectId);
      expect(spy).toHaveBeenCalledTimes(1);
      gate.resolve();
      await processing;
      await writer.process(project.projectId);
      expect((await mapping(project.revisionId)).status).toBe('ready');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  });

  it('bounds failed attempts, blocks descendants and supports an explicit scoped retry', async () => {
    const next = (await save([{ type: 'updateContext', content: 'v2' }]).expect(201)).body;
    const failure = jest
      .spyOn(git, 'write')
      .mockRejectedValue(new GitHistoryError('GIT_UNAVAILABLE'));
    try {
      for (let index = 0; index < 5; index++) {
        await writer.process(project.projectId);
        await due();
      }
      await writer.process(project.projectId);
      expect(failure).toHaveBeenCalledTimes(5);
      expect(await mapping(project.revisionId)).toMatchObject({
        status: 'failed',
        attempts: 5,
        errorCode: 'GIT_UNAVAILABLE',
      });
      expect((await mapping(next.revisionId)).status).toBe('pending');
      const retry = await client()
        .post(`${projectPath()}/history/retry`)
        .auth(token, { type: 'bearer' })
        .expect(202);
      expect(retry.body.resetCount).toBe(1);
      expect((await mapping(project.revisionId)).attempts).toBe(0);
    } finally {
      failure.mockRestore();
    }
    await writer.process(project.projectId);
    expect((await mapping(next.revisionId)).status).toBe('ready');
  });

  it('rebuilds a lost repository and a missing parent mapping with exactly the same SHAs', async () => {
    const next = (await save([{ type: 'updateContext', content: 'v2' }]).expect(201)).body;
    await writer.rebuild(project.projectId);
    const first = (await mapping(project.revisionId)).commitSha;
    const second = (await mapping(next.revisionId)).commitSha;
    await rm(repo(), { recursive: true, force: true });
    await writer.rebuild(project.projectId);
    expect((await mapping(project.revisionId)).commitSha).toBe(first);
    expect((await mapping(next.revisionId)).commitSha).toBe(second);
    await database.manager.delete(GitRevisionMapping, { revisionId: project.revisionId });
    await writer.rebuild(project.projectId);
    expect(await mapping(project.revisionId)).toMatchObject({ status: 'ready', commitSha: first });
    expect(command(['rev-list', '--count', 'refs/heads/main'])).toBe('2');
  });

  it('reports an unsuccessful maintenance rebuild as a failure', async () => {
    const failure = jest
      .spyOn(git, 'write')
      .mockRejectedValueOnce(new GitHistoryError('GIT_UNAVAILABLE'));
    try {
      await expect(writer.rebuild(project.projectId)).rejects.toMatchObject({
        code: 'GIT_UNAVAILABLE',
      });
      expect((await mapping(project.revisionId)).status).toBe('failed');
    } finally {
      failure.mockRestore();
    }
  });

  it('reports divergent refs without overwriting a foreign Git head', async () => {
    const next = (await save([{ type: 'updateContext', content: 'v2' }]).expect(201)).body;
    await writer.process(project.projectId);
    const head = command(['rev-parse', 'refs/heads/main']);
    const tree = command(['rev-parse', `${head}^{tree}`]);
    const foreign = command(['commit-tree', tree, '-p', head], 'External commit\n');
    command(['update-ref', 'refs/heads/main', foreign, head]);
    const pending = (
      await save([{ type: 'updateContext', content: 'v3' }], next.revisionId).expect(201)
    ).body;
    await writer.process(project.projectId);
    expect(await mapping(pending.revisionId)).toMatchObject({
      status: 'failed',
      errorCode: 'GIT_DIVERGED',
    });
    expect(command(['rev-parse', 'refs/heads/main'])).toBe(foreign);
    expect((await state().expect(200)).body.revision.id).toBe(pending.revisionId);
  });

  it('ignores repository hooks, document attributes and inherited Git environment', async () => {
    await writer.process(project.projectId);
    const marker = join(root, `hook-${randomUUID()}`);
    // init --template= creates no hooks directory, so use an explicit hooksPath in local config.
    const script = join(root, `hook-script-${randomUUID()}`);
    await writeFile(script, `#!/bin/sh\nprintf hacked > '${marker}'\n`);
    await chmod(script, 0o700);
    command(['config', 'core.hooksPath', root]);
    await writeFile(join(root, 'reference-transaction'), await readFile(script));
    await chmod(join(root, 'reference-transaction'), 0o700);
    command(['config', 'filter.evil.clean', script]);
    const next = (
      await save([
        { type: 'createFile', path: '.gitattributes', content: '*.txt filter=evil' },
        { type: 'createFile', path: '--option.txt', content: 'Exact bytes' },
        { type: 'createFile', path: 'розділ/текст.txt', content: 'Текст 😀' },
      ]).expect(201)
    ).body;
    const old = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = 'invalid';
    try {
      await writer.process(project.projectId);
    } finally {
      if (old === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = old;
    }
    expect((await mapping(next.revisionId)).status).toBe('ready');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(command(['show', 'refs/heads/main:--option.txt'])).toBe('Exact bytes');
    expect(command(['show', 'refs/heads/main:розділ/текст.txt'])).toBe('Текст 😀');
  });

  it('fences an expired publication lease and recovers the already-written commit', async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const write = git.write.bind(git);
    const spy = jest.spyOn(git, 'write').mockImplementationOnce(async (input, signal) => {
      entered.resolve();
      await gate.promise;
      return write(input, signal);
    });
    try {
      const active = writer.process(project.projectId);
      await entered.promise;
      await database.manager.update(
        GitRevisionMapping,
        { revisionId: project.revisionId },
        { leaseExpiresAt: new Date(Date.now() - 1000) },
      );
      await writer.recoverExpired();
      gate.resolve();
      await active;
      expect(await mapping(project.revisionId)).toMatchObject({
        status: 'failed',
        errorCode: 'WORKER_LOST',
      });
      const sha = command(['rev-parse', 'refs/heads/main']);
      await writer.process(project.projectId);
      expect(await mapping(project.revisionId)).toMatchObject({ status: 'ready', commitSha: sha });
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  });

  it('isolates users and nested IDs, validates restore/query inputs and denies MCP direct restore', async () => {
    const other = await account();
    const ownedOther = (await createProject().expect(201)).body;
    for (const path of [
      '/revisions',
      `/revisions/${project.revisionId}`,
      `/revisions/${project.revisionId}/diff?against=${project.revisionId}`,
    ])
      await client()
        .get(`${projectPath()}${path}`)
        .auth(other.accessToken, { type: 'bearer' })
        .expect(404);
    await diff(project.revisionId, ownedOther.revisionId).expect(404);
    await restore(ownedOther.revisionId, project.revisionId).expect(404);
    await client().get(`${projectPath()}/revisions`).expect(401);
    for (const input of [
      {},
      { targetRevisionId: '1', expectedCurrentRevisionId: 1 },
      { targetRevisionId: 0, expectedCurrentRevisionId: 1 },
      {
        targetRevisionId: project.revisionId,
        expectedCurrentRevisionId: project.revisionId,
        summary: null,
      },
      {
        targetRevisionId: project.revisionId,
        expectedCurrentRevisionId: project.revisionId,
        extra: true,
      },
    ])
      await client()
        .post(`${projectPath()}/restore`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(input)
        .expect(400);
    for (const against of ['01', '1e2', '-1', '2147483648'])
      await client()
        .get(`${projectPath()}/revisions/${project.revisionId}/diff`)
        .auth(token, { type: 'bearer' })
        .query({ against })
        .expect(400);
    await expect(
      app.get(HistoryService).restore(
        {
          userId: user.id,
          credentialId: Number(token.split('.')[0]),
          channel: 'mcp',
        },
        project.projectId,
        { targetRevisionId: project.revisionId, expectedCurrentRevisionId: project.revisionId },
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await database.manager.update(User, { id: user.id }, { emailVerifiedAt: null });
    await list().expect(403);
    await database.manager.update(User, { id: user.id }, { emailVerifiedAt: new Date() });
    await app.get(SessionService).revoke(user.id, Number(token.split('.')[0]));
    await list().expect(401);
  });

  it('keeps deleted projects inaccessible and does not publish mappings after deletion', async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const write = git.write.bind(git);
    const spy = jest.spyOn(git, 'write').mockImplementationOnce(async (input, signal) => {
      entered.resolve();
      await gate.promise;
      return write(input, signal);
    });
    try {
      const active = writer.process(project.projectId);
      await entered.promise;
      await client().delete(projectPath()).auth(token, { type: 'bearer' }).expect(204);
      gate.resolve();
      await active;
      expect((await mapping(project.revisionId)).status).not.toBe('ready');
      await list().expect(404);
      await detail(project.revisionId).expect(404);
      await restore(project.revisionId, project.revisionId).expect(404);
      await writer.process(project.projectId);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  });

  it('processes pending revisions directly from PostgreSQL without scanning ready repositories', async () => {
    await processPendingHistory(database, writer);
    expect((await mapping(project.revisionId)).status).toBe('ready');
    expect(command(['rev-list', '--count', 'refs/heads/main'])).toBe('1');
    const write = jest.spyOn(git, 'write');
    try {
      await processPendingHistory(database, writer);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
