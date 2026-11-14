import 'dotenv/config';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppConfigService } from '../../src/config/app-config.service';
import { validateWorkerEnvironment } from '../../src/config/environment';
import { DockerTypstSandbox } from '../../src/modules/compilation/infrastructure/docker-typst-sandbox';
import { SandboxTypstRunner } from '../../src/modules/compilation/infrastructure/sandbox-typst-runner';
import { pngResource } from '../fixtures/resources';

const exec = promisify(execFile);
const docker = (args: string[]) =>
  exec(process.env.TYPST_DOCKER_BINARY_PATH ?? 'docker', args, { timeout: 5000 });
const file = (path: string, content: string | Buffer, fileId = 1) => ({
  fileId,
  path,
  content: Buffer.isBuffer(content) ? content : Buffer.from(content),
});

describe('real Docker Typst sandbox', () => {
  let root: string;
  let config: AppConfigService;
  let runner: SandboxTypstRunner;
  let probeImage: string;
  let imageRoot: string;
  const probeRunner = () => {
    const probeConfig = {
      typstDockerImage: probeImage,
      typstDockerBinaryPath: config.typstDockerBinaryPath,
      compileWorkPath: root,
    } as AppConfigService;
    return new SandboxTypstRunner(probeConfig, new DockerTypstSandbox(probeConfig));
  };
  beforeAll(async () => {
    imageRoot = await mkdtemp(join(tmpdir(), 'typstoria-probe-image-'));
    const image = validateWorkerEnvironment({
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
    }).TYPST_DOCKER_IMAGE;
    await writeFile(
      join(imageRoot, 'Dockerfile'),
      `FROM ${image}\nCOPY --chmod=755 probe.sh /bin/typst\n`,
    );
    await writeFile(
      join(imageRoot, 'probe.sh'),
      `#!/bin/sh
case "$(head -n1 /input/main.typ)" in
isolation) sleep 60 & wait ;;
defeat-timeout) kill -KILL -1; while :; do :; done ;;
logs) yes diagnostics >&2 ;;
pdf-limit) head -c 30000000 /dev/zero ;;
memory) awk 'BEGIN { for(i=0;;i++) a[i]=sprintf("%01000d", i) }' ;;
esac
`,
    );
    probeImage = (await docker(['build', '--quiet', imageRoot])).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(probeImage)) throw new Error('Missing test image');
  });
  afterAll(async () => {
    if (probeImage) await docker(['image', 'rm', probeImage]);
    if (imageRoot) await rm(imageRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'typstoria-docker-')));
    config = new AppConfigService(
      validateWorkerEnvironment({
        ...process.env,
        DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
        COMPILE_WORK_PATH: root,
      }),
    );
    runner = new SandboxTypstRunner(config, new DockerTypstSandbox(config));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('compiles deterministic Ukrainian text, imports and resources through the pinned image', async () => {
    const input = {
      mainFileId: 1,
      files: [
        file(
          'src/main.typ',
          '= Український документ\n#include "../chapter.typ"\n#image("../assets/logo.png", width: 10pt)',
        ),
        file('chapter.typ', 'Літери ї, є, ґ та emoji 🙂.', 2),
        file('assets/logo.png', pngResource, 3),
      ],
    };
    const first = await runner.compile(input);
    const second = await runner.compile(input);
    expect(first).toMatchObject({ status: 'succeeded', errorCode: null });
    expect(first.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(first.pdf!.length).toBeGreaterThan(1000);
    expect(second.pdf).toEqual(first.pdf);
    expect(second.compilerFingerprint).toBe(first.compilerFingerprint);
    expect(await readdir(root)).toEqual([]);
  });

  it('reports actual syntax errors and cannot access outside files or download packages', async () => {
    const broken = await runner.compile({
      mainFileId: 1,
      files: [file('main.typ', '#include "broken.typ"'), file('broken.typ', '#let broken = (', 2)],
    });
    expect(broken).toMatchObject({ status: 'failed', errorCode: 'TYPST_ERROR' });
    expect(broken.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: 2, path: 'broken.typ', severity: 'error' }),
      ]),
    );
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'HOST_SECRET_MUST_NOT_APPEAR');
    const escaped = await runner.compile({
      mainFileId: 1,
      files: [file('main.typ', `#read("${secret}")`)],
    });
    expect(escaped.status).toBe('failed');
    expect(escaped.pdf).toBeUndefined();
    expect(JSON.stringify(escaped.diagnostics)).not.toContain(root);
    expect(JSON.stringify(escaped.diagnostics)).not.toContain('HOST_SECRET_MUST_NOT_APPEAR');
    const dependency = await runner.compile({
      mainFileId: 1,
      files: [file('main.typ', '#import "@preview/cetz:0.3.0": *')],
    });
    expect(dependency).toMatchObject({ status: 'failed', errorCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(await readdir(root)).toEqual(['secret.txt']);
  });

  it('enforces container isolation and removes the whole process tree on cancellation', async () => {
    const controller = new AbortController();
    const task = probeRunner().compile(
      { mainFileId: 1, files: [file('main.typ', 'isolation')] },
      controller.signal,
    );
    let name: string | undefined;
    let result;
    try {
      const until = Date.now() + 5000;
      while (!name && Date.now() < until) {
        const { stdout } = await docker([
          'ps',
          '--filter',
          'label=typstoria.compiler=true',
          '--format',
          '{{.Names}}',
        ]);
        for (const candidate of stdout.trim().split('\n').filter(Boolean)) {
          const details = JSON.parse((await docker(['inspect', candidate])).stdout)[0];
          if (details.Mounts.some((mount: { Source: string }) => mount.Source.startsWith(root))) {
            name = candidate;
            expect(details.Config.User).toBe('1000:1000');
            expect(details.HostConfig).toMatchObject({
              NetworkMode: 'none',
              ReadonlyRootfs: true,
              Memory: 536870912,
              MemorySwap: 536870912,
              NanoCpus: 1000000000,
              PidsLimit: 32,
              Privileged: false,
              Init: true,
              CapDrop: ['ALL'],
              SecurityOpt: expect.arrayContaining(['no-new-privileges', 'seccomp=builtin']),
            });
            expect(details.Mounts.every((mount: { RW: boolean }) => !mount.RW)).toBe(true);
            const probe = await docker([
              'exec',
              candidate,
              '/bin/sh',
              '-c',
              'test "$(id -u)" = 1000 && test ! -e /var/run/docker.sock && test -z "$DATABASE_URL" && test -z "$MAILJET_SECRET_KEY" && ! touch /input/forbidden && ! touch /forbidden && touch /tmp/scratch && grep -q "NoNewPrivs:.*1" /proc/self/status && grep -q "Seccomp:.*2" /proc/self/status && grep -q "CapEff:.*0000000000000000" /proc/self/status && test "$(wc -l < /proc/net/route)" = 1',
            ]);
            expect(probe.stderr).not.toContain('HOST_SECRET');
            break;
          }
        }
        if (!name) await new Promise((done) => setTimeout(done, 50));
      }
      expect(name).toBeDefined();
    } finally {
      controller.abort();
      result = await task;
    }
    expect(result).toMatchObject({ status: 'timed_out' });
    const { stdout } = await docker([
      'ps',
      '--all',
      '--filter',
      `name=${name}`,
      '--format',
      '{{.Names}}',
    ]);
    expect(stdout.trim()).toBe('');
    expect(await readdir(root)).toEqual([]);
  });

  it('bounds diagnostic output, PDF output and memory in the real container', async () => {
    for (const mode of ['logs', 'pdf-limit']) {
      const result = await probeRunner().compile({
        mainFileId: 1,
        files: [file('main.typ', mode)],
      });
      expect(result).toMatchObject({ status: 'failed', errorCode: 'OUTPUT_LIMIT' });
      expect(result.pdf).toBeUndefined();
    }
    const memory = await probeRunner().compile({
      mainFileId: 1,
      files: [file('main.typ', 'memory')],
    });
    expect(memory).toMatchObject({ status: 'failed', errorCode: 'RESOURCE_LIMIT' });
    expect(memory.pdf).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a container when cancellation races delayed creation', async () => {
    const wrapper = join(root, 'delayed-docker');
    await writeFile(
      wrapper,
      '#!/bin/sh\nif [ "$1" = create ]; then printf "%s\\n" "$@" > "$0.started"; sleep 1; fi\nexec docker "$@"\n',
      { mode: 0o700 },
    );
    const delayedConfig = {
      typstDockerImage: config.typstDockerImage,
      typstDockerBinaryPath: wrapper,
      compileWorkPath: root,
    } as AppConfigService;
    const delayed = new SandboxTypstRunner(delayedConfig, new DockerTypstSandbox(delayedConfig));
    const controller = new AbortController();
    const task = delayed.compile(
      { mainFileId: 1, files: [file('main.typ', 'Hello')] },
      controller.signal,
    );
    let args: string[] = [];
    try {
      const deadline = Date.now() + 5000;
      while (!args.length && Date.now() < deadline) {
        try {
          args = (await readFile(wrapper + '.started', 'utf8')).trim().split('\n');
        } catch {
          await new Promise((done) => setTimeout(done, 50));
        }
      }
      expect(args).toContain('--name');
    } finally {
      controller.abort();
      await task;
    }
    const name = args[args.indexOf('--name') + 1]!;
    const { stdout } = await docker([
      'ps',
      '--all',
      '--filter',
      `name=${name}`,
      '--format',
      '{{.Names}}',
    ]);
    expect(stdout.trim()).toBe('');
    expect((await readdir(root)).filter((name) => name.startsWith('attempt-'))).toEqual([]);
  });

  it('enforces its own deadline after the worker is killed', async () => {
    const worker = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-e',
        `
      const { SandboxTypstRunner } = require('./src/modules/compilation/infrastructure/sandbox-typst-runner');
      const { DockerTypstSandbox } = require('./src/modules/compilation/infrastructure/docker-typst-sandbox');
      const config = {typstDockerImage:process.env.PROBE_IMAGE,typstDockerBinaryPath:'docker',compileWorkPath:process.env.PROBE_SCRATCH};
      new SandboxTypstRunner(config, new DockerTypstSandbox(config)).compile({mainFileId:1,files:[{fileId:1,path:'main.typ',content:Buffer.from('defeat-timeout')}]});
    `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PROBE_IMAGE: probeImage, PROBE_SCRATCH: root },
        stdio: 'ignore',
      },
    );
    let name: string | undefined;
    try {
      const until = Date.now() + 8000;
      while (!name && Date.now() < until) {
        const { stdout } = await docker([
          'ps',
          '--filter',
          'label=typstoria.compiler=true',
          '--format',
          '{{.Names}}',
        ]);
        for (const candidate of stdout.trim().split('\n').filter(Boolean)) {
          const details = JSON.parse((await docker(['inspect', candidate])).stdout)[0];
          if (details.Mounts.some((mount: { Source: string }) => mount.Source.startsWith(root))) {
            name = candidate;
            break;
          }
        }
        if (!name) await new Promise((done) => setTimeout(done, 100));
      }
      expect(name).toBeDefined();
      worker.kill('SIGKILL');
      let running = true;
      const deadline = Date.now() + 35_000;
      while (running && Date.now() < deadline) {
        running =
          (
            await docker(['ps', '--all', '--filter', `name=${name}`, '--format', '{{.State}}'])
          ).stdout.trim() === 'running';
        if (running) await new Promise((done) => setTimeout(done, 500));
      }
      expect(running).toBe(false);
    } finally {
      worker.kill('SIGKILL');
      if (name)
        await docker(['rm', '--force', name]).catch((error: unknown) => {
          if (!/No such container/i.test(String(error))) throw error;
        });
    }
  });

  it('fails closed for an unavailable image and for a cancelled request', async () => {
    const missingConfig = {
      typstDockerImage: `missing@sha256:${'0'.repeat(64)}`,
      typstDockerBinaryPath: config.typstDockerBinaryPath,
      compileWorkPath: root,
    } as AppConfigService;
    const missing = new SandboxTypstRunner(missingConfig, new DockerTypstSandbox(missingConfig));
    expect(
      await missing.compile({ mainFileId: 1, files: [file('main.typ', 'Hello')] }),
    ).toMatchObject({ status: 'failed', errorCode: 'RUNNER_UNAVAILABLE' });
    const controller = new AbortController();
    controller.abort();
    expect(
      await runner.compile(
        { mainFileId: 1, files: [file('main.typ', 'Hello')] },
        controller.signal,
      ),
    ).toMatchObject({ status: 'timed_out' });
    expect(await readdir(root)).toEqual([]);
  });
});
