import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { normalizedProjectPath } from '../../projects/domain/text-changes';
import {
  MAX_PDF_BYTES,
  TypstRunner,
  type CompileInput,
  type CompileResult,
} from '../domain/compilation';
import { typstDiagnostics } from './typst-diagnostics';
import { SANDBOX_POLICY, type TypstSandbox } from './typst-sandbox';

/** Shared compile lifecycle. Isolation is provided explicitly by the composition root. */
export class SandboxTypstRunner extends TypstRunner {
  private lastCleanup = 0;
  constructor(
    private readonly config: AppConfigService,
    private readonly sandbox: TypstSandbox,
  ) {
    super();
  }

  async compile(input: CompileInput, signal?: AbortSignal): Promise<CompileResult> {
    let directory: string | undefined;
    let compilerFingerprint = createHash('sha256').update(SANDBOX_POLICY).digest('hex');
    const failure = (
      errorCode: CompileResult['errorCode'],
      status: CompileResult['status'] = 'failed',
    ): CompileResult => ({
      status,
      errorCode,
      compilerFingerprint,
      diagnostics: [],
    });
    try {
      if (signal?.aborted) return failure('RESOURCE_LIMIT', 'timed_out');
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
      if (signal?.aborted) return failure('RESOURCE_LIMIT', 'timed_out');
      const execution = await this.sandbox.execute(
        { source, output, entrypoint: main.path },
        signal,
      );
      const diagnostics = typstDiagnostics(execution.stderr, input.files);
      const failed = (
        errorCode: CompileResult['errorCode'],
        status: CompileResult['status'] = 'failed',
      ): CompileResult => ({
        status,
        errorCode,
        compilerFingerprint,
        diagnostics,
      });
      if (execution.timedOut) return failed('RESOURCE_LIMIT', 'timed_out');
      if (execution.outputLimit) return failed('OUTPUT_LIMIT');
      if (execution.resourceLimit) return failed('RESOURCE_LIMIT');
      if (execution.code !== 0) {
        if (
          execution.code === 153 ||
          /file too large|file size limit|status=25/i.test(execution.stderr)
        )
          return failed('OUTPUT_LIMIT');
        if (
          [137, 152].includes(execution.code ?? 0) ||
          /status=9|status=24|oom-kill|out of memory|memory allocation.*failed/i.test(
            execution.stderr,
          )
        )
          return failed('RESOURCE_LIMIT');
        if (
          /failed to download package|package.*not found|network.*unreachable/i.test(
            execution.stderr,
          )
        )
          return failed('DEPENDENCY_UNAVAILABLE');
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
          return failed('TYPST_ERROR');
        return failed('RUNNER_UNAVAILABLE');
      }
      // A compromised compiler must not make the host follow an output symlink.
      const handle = await open(
        join(output, 'document.pdf'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_PDF_BYTES) return failed('OUTPUT_LIMIT');
        const pdf = await handle.readFile();
        if (
          !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
          !pdf.subarray(-1024).includes(Buffer.from('%%EOF'))
        )
          return failed('INTERNAL_ERROR');
        return { status: 'succeeded', errorCode: null, compilerFingerprint, diagnostics, pdf };
      } finally {
        await handle.close();
      }
    } catch {
      return failure('RUNNER_UNAVAILABLE');
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
