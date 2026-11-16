import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { MAX_PDF_BYTES, MAX_PREVIEW_BYTES } from '../domain/compilation';
import { SandboxTypstRunner } from './sandbox-typst-runner';
import { typstArguments, type SandboxWorkspace, type TypstSandbox } from './typst-sandbox';

const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3,
]);
const fingerprint = createHash('sha256').update('isolated-runtime').digest('hex');

describe('shared isolated compile lifecycle', () => {
  it('keeps PDF arguments as the default and limits PNG arguments to page one at 72 ppi', () => {
    expect(typstArguments('main.typ').slice(-3)).toEqual([
      'pdf',
      './main.typ',
      '/output/document.pdf',
    ]);
    expect(typstArguments('main.typ', '-', 'png').slice(-7)).toEqual([
      'png',
      '--pages',
      '1',
      '--ppi',
      '72',
      './main.typ',
      '-',
    ]);
  });

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

  it('renders and validates first-page PNG previews through the same isolated lifecycle', async () => {
    sandbox.execute = jest.fn().mockImplementation(async ({ output, format }: SandboxWorkspace) => {
      await writeFile(join(output, `document.${format}`), format === 'png' ? png : pdf);
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    });
    const compiled = await runner.compile(input);
    const preview = await runner.preview(input);
    expect(preview).toEqual(png);
    expect(sandbox.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: 'png' }),
      undefined,
    );
    expect(compiled.compilerFingerprint).toBe(fingerprint);
    expect(await readdir(root)).toEqual([]);
  });

  it('throws on malformed, oversized, or excessive-dimension PNG preview output', async () => {
    sandbox.execute = async ({ output }) => {
      await writeFile(join(output, 'document.png'), 'not png');
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    await expect(runner.preview(input)).rejects.toThrow();
    sandbox.execute = async ({ output }) => {
      await writeFile(join(output, 'document.png'), Buffer.alloc(MAX_PREVIEW_BYTES + 1));
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    await expect(runner.preview(input)).rejects.toThrow();
    sandbox.execute = async ({ output }) => {
      const oversized = Buffer.from(png);
      oversized.writeUInt32BE(4097, 16);
      await writeFile(join(output, 'document.png'), oversized);
      return { code: 0, stderr: '', timedOut: false, outputLimit: false };
    };
    await expect(runner.preview(input)).rejects.toThrow();
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
