import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { normalizedProjectPath } from '../../projects/domain/text-changes';
import {
  MAX_PDF_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_DIMENSION,
  MAX_PREVIEW_PIXELS,
  TypstRunner,
  type CompileDiagnostic,
  type CompileInput,
  type CompileResult,
} from '../domain/compilation';
import { typstDiagnostics } from './typst-diagnostics';
import { SANDBOX_POLICY, type SandboxWorkspace, type TypstSandbox } from './typst-sandbox';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RenderedArtifact {
  bytes: Buffer;
  compilerFingerprint: string;
  diagnostics: CompileDiagnostic[];
}

class RenderFailure extends Error {
  constructor(
    readonly errorCode: CompileResult['errorCode'],
    readonly status: CompileResult['status'],
    readonly compilerFingerprint: string,
    readonly diagnostics: CompileDiagnostic[] = [],
  ) {
    super(errorCode ?? status);
  }
}

/** Shared isolated render lifecycle. Isolation is provided explicitly by the composition root. */
export class SandboxTypstRunner extends TypstRunner {
  private lastCleanup = 0;
  constructor(
    private readonly config: AppConfigService,
    private readonly sandbox: TypstSandbox,
  ) {
    super();
  }

  async compile(input: CompileInput, signal?: AbortSignal): Promise<CompileResult> {
    try {
      const rendered = await this.render(input, 'pdf', signal);
      return {
        status: 'succeeded',
        errorCode: null,
        compilerFingerprint: rendered.compilerFingerprint,
        diagnostics: rendered.diagnostics,
        pdf: rendered.bytes,
      };
    } catch (error) {
      if (error instanceof RenderFailure) {
        return {
          status: error.status,
          errorCode: error.errorCode,
          compilerFingerprint: error.compilerFingerprint,
          diagnostics: error.diagnostics,
        };
      }
      return {
        status: 'failed',
        errorCode: 'RUNNER_UNAVAILABLE',
        compilerFingerprint: createHash('sha256').update(SANDBOX_POLICY).digest('hex'),
        diagnostics: [],
      };
    }
  }

  async preview(input: CompileInput, signal?: AbortSignal): Promise<Buffer> {
    return (await this.render(input, 'png', signal)).bytes;
  }

  private async render(
    input: CompileInput,
    format: 'pdf' | 'png',
    signal?: AbortSignal,
  ): Promise<RenderedArtifact> {
    let directory: string | undefined;
    let compilerFingerprint = createHash('sha256').update(SANDBOX_POLICY).digest('hex');
    const fail = (
      errorCode: CompileResult['errorCode'],
      status: CompileResult['status'] = 'failed',
      diagnostics: CompileDiagnostic[] = [],
    ): never => {
      throw new RenderFailure(errorCode, status, compilerFingerprint, diagnostics);
    };
    try {
      if (signal?.aborted) fail('RESOURCE_LIMIT', 'timed_out');
      compilerFingerprint = await this.sandbox.fingerprint();
      const root = resolve(this.config.compileWorkPath);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.cleanupAbandoned(root);
      directory = await mkdtemp(join(root, 'attempt-'));
      const source = join(directory, 'input');
      const output = join(directory, 'output');
      await mkdir(source, { mode: 0o755 });
      await mkdir(output, { mode: 0o700 });
      for (const file of input.files) {
        const path = normalizedProjectPath(file.path);
        const target = join(source, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, file.content, { mode: 0o444, flag: 'wx' });
      }
      const main = input.files.find((file) => file.fileId === input.mainFileId);
      if (!main) throw new Error('Missing entrypoint');
      if (signal?.aborted) fail('RESOURCE_LIMIT', 'timed_out');
      const workspace: SandboxWorkspace = {
        source,
        output,
        entrypoint: main.path,
        ...(format === 'png' ? { format } : {}),
      };
      const execution = await this.sandbox.execute(workspace, signal);
      const diagnostics = typstDiagnostics(execution.stderr, input.files);
      const failed = (
        errorCode: CompileResult['errorCode'],
        status: CompileResult['status'] = 'failed',
      ): never => fail(errorCode, status, diagnostics);
      if (execution.timedOut) failed('RESOURCE_LIMIT', 'timed_out');
      if (execution.outputLimit) failed('OUTPUT_LIMIT');
      if (execution.resourceLimit) failed('RESOURCE_LIMIT');
      if (execution.code !== 0) {
        if (
          execution.code === 153 ||
          /file too large|file size limit|status=25/i.test(execution.stderr)
        )
          failed('OUTPUT_LIMIT');
        if (
          [137, 152].includes(execution.code ?? 0) ||
          /status=9|status=24|oom-kill|out of memory|memory allocation.*failed/i.test(
            execution.stderr,
          )
        )
          failed('RESOURCE_LIMIT');
        if (
          /failed to download package|package.*not found|network.*unreachable/i.test(
            execution.stderr,
          )
        )
          failed('DEPENDENCY_UNAVAILABLE');
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
          failed('TYPST_ERROR');
        failed('RUNNER_UNAVAILABLE');
      }

      const maxBytes = format === 'png' ? MAX_PREVIEW_BYTES : MAX_PDF_BYTES;
      const artifactPath = join(output, `document.${format}`);
      // A compromised compiler must not make the host follow output symlinks or block on FIFOs.
      const handle = await open(
        artifactPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes) failed('OUTPUT_LIMIT');
        const bytes = await handle.readFile();
        if (format === 'pdf') {
          if (
            !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
            !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
          )
            failed('INTERNAL_ERROR');
        } else if (!validPreviewPng(bytes)) {
          failed('INTERNAL_ERROR');
        }
        return { bytes, compilerFingerprint, diagnostics };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof RenderFailure) throw error;
      throw new RenderFailure('RUNNER_UNAVAILABLE', 'failed', compilerFingerprint);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async cleanupAbandoned(root: string): Promise<void> {
    const hour = 60 * 60 * 1000;
    if (Date.now() - this.lastCleanup < hour) return;
    this.lastCleanup = Date.now();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('attempt-')) continue;
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > hour)
        await rm(path, { recursive: true, force: true });
    }
  }
}

function validPreviewPng(bytes: Buffer): boolean {
  if (bytes.length < 24 || bytes.length > MAX_PREVIEW_BYTES) return false;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return (
    width >= 1 &&
    width <= MAX_PREVIEW_DIMENSION &&
    height >= 1 &&
    height <= MAX_PREVIEW_DIMENSION &&
    width * height <= MAX_PREVIEW_PIXELS
  );
}
