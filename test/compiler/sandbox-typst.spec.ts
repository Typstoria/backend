import 'dotenv/config';
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../src/config/app-config.service';
import { SandboxTypstRunner } from '../../src/modules/compilation/infrastructure/sandbox-typst-runner';
import { pngResource } from '../fixtures/resources';

describe('real Linux Typst sandbox', () => {
  let root: string;
  let runner: SandboxTypstRunner;
  const file = (path: string, content: string | Buffer, fileId = 1) => ({
    fileId,
    path,
    content: Buffer.isBuffer(content) ? content : Buffer.from(content),
  });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-runner-'));
    runner = new SandboxTypstRunner({
      typstBinaryPath: process.env.TYPST_BINARY_PATH ?? '/usr/local/bin/typst',
      compileWorkPath: root,
    } as AppConfigService);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('compiles Ukrainian text, nested imports and a PNG using only the supplied files', async () => {
    const input = {
      mainFileId: 1,
      files: [
        file(
          'src/main.typ',
          '= Український документ\n#include "../chapter.typ"\n#image("../assets/logo.png", width: 10pt)',
        ),
        file('chapter.typ', 'Текст розділу з літерами ї, є, ґ.', 2),
        file('assets/logo.png', pngResource, 3),
      ],
    };
    const first = await runner.compile(input);
    const second = await runner.compile(input);
    expect(first).toMatchObject({ status: 'succeeded', errorCode: null });
    expect(first.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(second.pdf).toEqual(first.pdf);
    expect(second.compilerFingerprint).toBe(first.compilerFingerprint);
    expect(await readdir(root)).toEqual([]);
  });

  it('returns syntax errors from their actual file and leaves no previous PDF', async () => {
    const result = await runner.compile({
      mainFileId: 1,
      files: [file('main.typ', '#include "broken.typ"'), file('broken.typ', '#let broken = (', 2)],
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'TYPST_ERROR' });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: 2, path: 'broken.typ', severity: 'error', range: null }),
      ]),
    );
    expect(result.pdf).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('denies traversal to a host secret and cannot download missing packages', async () => {
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'DO_NOT_EXPOSE');
    try {
      const result = await runner.compile({
        mainFileId: 1,
        files: [file('main.typ', `#read("${secret}")`)],
      });
      expect(result.status).toBe('failed');
      expect(result.pdf).toBeUndefined();
      expect(JSON.stringify(result.diagnostics)).not.toContain(root);
      const traversal = await runner.compile({
        mainFileId: 1,
        files: [file('main.typ', '#read("../secret.txt")')],
      });
      expect(traversal.errorCode).toBe('TYPST_ERROR');
      const dependency = await runner.compile({
        mainFileId: 1,
        files: [file('main.typ', '#import "@preview/cetz:0.3.0": *')],
      });
      expect(dependency).toMatchObject({ status: 'failed', errorCode: 'DEPENDENCY_UNAVAILABLE' });
    } finally {
      await rm(secret);
    }
  });

  it('kills a sandbox process tree on abort and cleans its scratch space', async () => {
    const probe = join(root, 'timeout.py');
    await writeFile(
      probe,
      '#!/usr/bin/python3\nimport subprocess, time\nsubprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(60)"])\ntime.sleep(60)\n',
    );
    await chmod(probe, 0o700);
    const slow = new SandboxTypstRunner({
      typstBinaryPath: probe,
      compileWorkPath: root,
    } as AppConfigService);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const start = Date.now();
    try {
      const result = await slow.compile(
        {
          mainFileId: 1,
          files: [file('main.typ', 'Hello')],
        },
        controller.signal,
      );
      expect(result.status).toBe('timed_out');
      expect(result.pdf).toBeUndefined();
      expect(Date.now() - start).toBeLessThan(6000);
      expect(await readdir(root)).toEqual(['timeout.py']);
    } finally {
      clearTimeout(timer);
      await rm(probe);
    }
  });

  it('fails closed when the compiler is missing', async () => {
    const missing = new SandboxTypstRunner({
      typstBinaryPath: join(root, 'missing'),
      compileWorkPath: root,
    } as AppConfigService);
    expect(
      await missing.compile({ mainFileId: 1, files: [file('main.typ', 'Hello')] }),
    ).toMatchObject({ status: 'failed', errorCode: 'RUNNER_UNAVAILABLE' });
  });

  it('cleans old abandoned attempts while preserving a recent attempt directory', async () => {
    const old = join(root, 'attempt-abandoned');
    const recent = join(root, 'attempt-recent');
    await mkdir(old);
    await mkdir(recent);
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, past, past);
    const freshRunner = new SandboxTypstRunner({
      typstBinaryPath: process.env.TYPST_BINARY_PATH ?? '/usr/local/bin/typst',
      compileWorkPath: root,
    } as AppConfigService);
    try {
      expect(
        (await freshRunner.compile({ mainFileId: 1, files: [file('main.typ', 'Hello')] })).status,
      ).toBe('succeeded');
      expect(await readdir(root)).toEqual(['attempt-recent']);
    } finally {
      await rm(recent, { recursive: true, force: true });
    }
  });

  it('enforces OS filesystem, environment, identity and network isolation independently of Typst', async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const probe = join(root, 'probe.py');
    await writeFile(
      probe,
      `#!/usr/bin/python3
import os, socket
assert os.getuid() != 0
assert 'DATABASE_URL' not in os.environ
assert 'MAILJET_SECRET_KEY' not in os.environ
assert not os.path.exists('/etc/passwd')
assert not os.path.exists('/home/yehor/.codex')
try:
    open('/input/main.typ', 'w').write('forbidden')
    raise AssertionError('input was writable')
except OSError:
    pass
try:
    socket.create_connection(('127.0.0.1', ${address.port}), timeout=0.2)
    raise AssertionError('host network was reachable')
except OSError:
    pass
open('/tmp/scratch', 'w').write('private')
open('/output/document.pdf', 'wb').write(b'%PDF-1.7\\nprobe\\n%%EOF')
`,
    );
    await chmod(probe, 0o700);
    try {
      const isolated = new SandboxTypstRunner({
        typstBinaryPath: probe,
        compileWorkPath: root,
      } as AppConfigService);
      expect(
        await isolated.compile({ mainFileId: 1, files: [file('main.typ', 'Private source')] }),
      ).toMatchObject({ status: 'succeeded' });
    } finally {
      await rm(probe);
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('enforces the cgroup memory ceiling and bounded diagnostic output', async () => {
    const probe = join(root, 'limits.py');
    await writeFile(
      probe,
      '#!/usr/bin/python3\na = bytearray(700 * 1024 * 1024)\nopen("/output/document.pdf", "wb").write(b"%PDF-1.7\\nshould-not-succeed\\n%%EOF")\n',
    );
    await chmod(probe, 0o700);
    try {
      const limited = new SandboxTypstRunner({
        typstBinaryPath: probe,
        compileWorkPath: root,
      } as AppConfigService);
      const memory = await limited.compile({ mainFileId: 1, files: [file('main.typ', 'Hello')] });
      expect(memory).toMatchObject({ status: 'failed', errorCode: 'RESOURCE_LIMIT' });
      expect(memory.pdf).toBeUndefined();
      await writeFile(
        probe,
        '#!/usr/bin/python3\nimport sys\nwhile True: sys.stderr.write("x" * 4096)\n',
      );
      expect(
        await limited.compile({ mainFileId: 1, files: [file('main.typ', 'Hello')] }),
      ).toMatchObject({ status: 'failed', errorCode: 'OUTPUT_LIMIT' });
    } finally {
      await rm(probe);
    }
  });
});
