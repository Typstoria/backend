import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { MAX_PDF_BYTES } from '../domain/compilation';
import { SandboxTypstRunner } from './sandbox-typst-runner';
import type { SandboxWorkspace, TypstSandbox } from './typst-sandbox';

const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const fingerprint = createHash('sha256').update('isolated-runtime').digest('hex');

describe('shared isolated compile lifecycle', () => {
  let root: string;
  let sandbox: TypstSandbox;
  let runner: SandboxTypstRunner;
  const input = {
    mainFileId: 1,
    files: [{ fileId: 1, path: 'main.typ', content: Buffer.from('Hello') }],
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-shared-'));
    sandbox = {
      fingerprint: jest.fn().mockResolvedValue(fingerprint),
      execute: jest.fn().mockImplementation(async ({ output }: SandboxWorkspace) => {
        await writeFile(join(output, 'document.pdf'), pdf);
        return { code: 0, stderr: '', timedOut: false, outputLimit: false };
      }),
    };
    runner = new SandboxTypstRunner({ compileWorkPath: root } as AppConfigService, sandbox);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('validates the runtime PDF and cleans every attempt', async () => {
    expect(await runner.compile(input)).toMatchObject({
      status: 'succeeded',
      pdf,
      compilerFingerprint: fingerprint,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects output symlinks without reading a host secret', async () => {
    const secret = join(root, 'secret.pdf');
    await writeFile(secret, pdf);
    sandbox.execute = async ({ output }) => {
      await symlink(secret, join(output, 'document.pdf'));
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    expect(await runner.compile(input)).toMatchObject({
      status: 'failed',
      errorCode: 'RUNNER_UNAVAILABLE',
    });
    expect(await readdir(root)).toEqual(['secret.pdf']);
  });

  it('rejects FIFO output without blocking a filesystem worker', async () => {
    sandbox.execute = async ({ output }) => {
      await promisify(execFile)('mkfifo', [join(output, 'document.pdf')]);
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    expect(await runner.compile(input)).toMatchObject({
      status: 'failed',
      errorCode: 'OUTPUT_LIMIT',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects oversized and malformed PDF output', async () => {
    sandbox.execute = async ({ output }) => {
      const path = join(output, 'document.pdf');
      await writeFile(path, 'not a PDF');
      await truncate(path, MAX_PDF_BYTES + 1);
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    expect(await runner.compile(input)).toMatchObject({
      status: 'failed',
      errorCode: 'OUTPUT_LIMIT',
    });
    sandbox.execute = async ({ output }) => {
      await writeFile(join(output, 'document.pdf'), 'not a PDF');
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    expect(await runner.compile(input)).toMatchObject({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('does not start isolation after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runner.compile(input, controller.signal)).toMatchObject({ status: 'timed_out' });
    expect(sandbox.execute).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
