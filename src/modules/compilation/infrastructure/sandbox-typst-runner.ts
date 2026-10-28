import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { normalizedProjectPath } from '../../projects/domain/text-changes';
import {
  MAX_PDF_BYTES,
  TypstRunner,
  type CompileInput,
  type CompileResult,
} from '../domain/compilation';
import { typstDiagnostics } from './typst-diagnostics';

const POLICY =
  'typstoria-linux-bwrap-systemd-v1;512MiB;1CPU;32tasks;30s;25MiBpdf;256KiBlogs;embedded-fonts;empty-packages;epoch0;short-diagnostics';

/** Linux host adapter. Missing namespace/cgroup isolation fails closed; there is no bare CLI fallback. */
@Injectable()
export class SandboxTypstRunner extends TypstRunner {
  private lastCleanup = 0;
  constructor(private readonly config: AppConfigService) {
    super();
  }

  async compile(input: CompileInput, signal?: AbortSignal): Promise<CompileResult> {
    let directory: string | undefined;
    let compilerFingerprint = createHash('sha256').update(POLICY).digest('hex');
    try {
      const binary = resolve(this.config.typstBinaryPath);
      compilerFingerprint = createHash('sha256')
        .update(POLICY)
        .update(await readFile(binary))
        .digest('hex');
      const root = resolve(this.config.compileWorkPath);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.cleanupAbandoned(root);
      directory = await mkdtemp(join(root, 'attempt-'));
      const source = join(directory, 'input');
      const output = join(directory, 'output');
      await mkdir(source, { mode: 0o700 });
      await mkdir(output, { mode: 0o700 });
      for (const file of input.files) {
        const path = normalizedProjectPath(file.path);
        const target = join(source, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { mode: 0o400, flag: 'wx' });
      }
      const main = input.files.find((file) => file.fileId === input.mainFileId);
      if (!main) throw new Error('Missing entrypoint');
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (process.platform !== 'linux' || !uid || gid === undefined)
        throw new Error('Unsupported runner host');
      const unit = `typstoria-compile-${randomUUID()}`;
      const args = [
        '--user',
        '--wait',
        '--pipe',
        '--collect',
        `--unit=${unit}`,
        '-p',
        'MemoryMax=536870912',
        '-p',
        'MemorySwapMax=0',
        '-p',
        'CPUQuota=100%',
        '-p',
        'TasksMax=32',
        '-p',
        'RuntimeMaxSec=30',
        '-p',
        'KillMode=control-group',
        '-p',
        'NoNewPrivileges=yes',
        '-p',
        'RestrictSUIDSGID=yes',
        '-p',
        'LockPersonality=yes',
        '-p',
        'SystemCallFilter=~@reboot @swap @raw-io @obsolete @debug @keyring',
        '--',
        '/usr/bin/prlimit',
        `--fsize=${MAX_PDF_BYTES}`,
        '--core=0',
        '--nofile=128',
        '--cpu=30',
        '--',
        '/usr/bin/bwrap',
        '--unshare-all',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--uid',
        String(uid),
        '--gid',
        String(gid),
        '--clearenv',
        '--setenv',
        'HOME',
        '/tmp',
        '--setenv',
        'LANG',
        'C.UTF-8',
        '--setenv',
        'SOURCE_DATE_EPOCH',
        '0',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind',
        '/lib64',
        '/lib64',
        '--dir',
        '/runtime',
        '--ro-bind',
        binary,
        '/runtime/typst',
        '--ro-bind',
        source,
        '/input',
        '--bind',
        output,
        '/output',
        '--dir',
        '/packages',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--remount-ro',
        '/',
        '--chdir',
        '/input',
        '/runtime/typst',
        'compile',
        '--root',
        '/input',
        '--ignore-system-fonts',
        '--font-path',
        '/input',
        '--package-path',
        '/packages',
        '--package-cache-path',
        '/packages',
        '--creation-timestamp',
        '0',
        '--diagnostic-format',
        'short',
        '--jobs',
        '1',
        '--format',
        'pdf',
        `./${main.path}`,
        '/output/document.pdf',
      ];
      if (signal?.aborted)
        return {
          status: 'timed_out',
          errorCode: 'RESOURCE_LIMIT',
          compilerFingerprint,
          diagnostics: [],
        };
      const execution = await this.execute(unit, args, signal);
      const diagnostics = typstDiagnostics(execution.stderr, input.files);
      const failure = (
        errorCode: CompileResult['errorCode'],
        status: CompileResult['status'] = 'failed',
      ): CompileResult => ({ status, errorCode, compilerFingerprint, diagnostics });
      if (execution.timedOut) return failure('RESOURCE_LIMIT', 'timed_out');
      if (execution.outputLimit) return failure('OUTPUT_LIMIT');
      if (execution.code !== 0) {
        if (
          execution.code === 153 ||
          /file too large|file size limit|status=25/i.test(execution.stderr)
        )
          return failure('OUTPUT_LIMIT');
        if (
          [137, 152].includes(execution.code ?? 0) ||
          /status=9|status=24|oom-kill|out of memory|memory allocation.*failed/i.test(
            execution.stderr,
          )
        )
          return failure('RESOURCE_LIMIT');
        if (
          /failed to download package|package.*not found|network.*unreachable/i.test(
            execution.stderr,
          )
        )
          return failure('DEPENDENCY_UNAVAILABLE');
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
          return failure('TYPST_ERROR');
        return failure('RUNNER_UNAVAILABLE');
      }
      const target = join(output, 'document.pdf');
      const info = await stat(target);
      if (!info.isFile() || info.size > MAX_PDF_BYTES) return failure('OUTPUT_LIMIT');
      const pdf = await readFile(target);
      if (
        !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
        !pdf.subarray(-1024).includes(Buffer.from('%%EOF'))
      )
        return failure('INTERNAL_ERROR');
      return { status: 'succeeded', errorCode: null, compilerFingerprint, diagnostics, pdf };
    } catch {
      return {
        status: 'failed',
        errorCode: 'RUNNER_UNAVAILABLE',
        compilerFingerprint,
        diagnostics: [],
      };
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
      // Much longer than the hard 30s service lifetime; do not touch another active worker's attempt.
      if (info && Date.now() - info.mtimeMs > hour)
        await rm(path, { recursive: true, force: true });
    }
  }

  private execute(
    unit: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stderr: string; timedOut: boolean; outputLimit: boolean }> {
    return new Promise((resolveExecution) => {
      const runtime = `/run/user/${process.getuid!()}`;
      const environment = {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
      };
      const child = spawn('/usr/bin/systemd-run', args, {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      let outputLimit = false;
      let killing: Promise<void> | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const kill = () => {
        killing = new Promise<void>((done) => {
          const killer = spawn('/usr/bin/systemctl', ['--user', 'kill', '--signal=KILL', unit], {
            env: environment,
            stdio: 'ignore',
          });
          killer.once('error', () => done());
          killer.once('close', () => done());
        });
      };
      const requestKill = () => {
        kill();
        // Abort may race transient-unit creation; keep killing until systemd-run confirms exit.
        killTimer ??= setInterval(kill, 200);
      };
      const timeout = () => {
        timedOut = true;
        requestKill();
      };
      const timer = setTimeout(timeout, 29_500);
      signal?.addEventListener('abort', timeout, { once: true });
      if (signal?.aborted) timeout();
      const collect = (chunk: Buffer, error: boolean) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          outputLimit = true;
          if (!killTimer) requestKill();
        } else if (error) stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
      const finish = async (code: number | null) => {
        clearTimeout(timer);
        if (killTimer) clearInterval(killTimer);
        signal?.removeEventListener('abort', timeout);
        await killing;
        resolveExecution({ code, stderr, timedOut, outputLimit });
      };
      child.once('error', () => {
        void finish(null);
      });
      child.once('close', (code) => {
        void finish(code);
      });
    });
  }
}
