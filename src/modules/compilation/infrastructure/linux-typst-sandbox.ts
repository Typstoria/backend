import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppConfigService } from '../../../config/app-config.service';
import { MAX_PDF_BYTES, MAX_PREVIEW_BYTES } from '../domain/compilation';
import {
  SANDBOX_POLICY,
  typstArguments,
  type SandboxExecution,
  type SandboxWorkspace,
  type TypstSandbox,
} from './typst-sandbox';

const POLICY_PREFIX = 'typstoria-linux-bwrap-systemd-v1;';

/** Linux sandbox using user systemd, cgroups and bubblewrap namespaces. */
export class LinuxTypstSandbox implements TypstSandbox {
  constructor(private readonly config: AppConfigService) {}

  async fingerprint(): Promise<string> {
    const binary = resolve(this.config.typstBinaryPath);
    return createHash('sha256')
      .update(POLICY_PREFIX)
      .update(SANDBOX_POLICY)
      .update(await readFile(binary))
      .digest('hex');
  }

  async execute(workspace: SandboxWorkspace, signal?: AbortSignal): Promise<SandboxExecution> {
    const format = workspace.format ?? 'pdf';
    const outputLimit = format === 'png' ? MAX_PREVIEW_BYTES : MAX_PDF_BYTES;
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (process.platform !== 'linux' || !uid || gid === undefined)
      throw new Error('Unsupported runner host');

    if (signal?.aborted) return { code: null, stderr: '', timedOut: true, outputLimit: false };

    const binary = resolve(this.config.typstBinaryPath);
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
      `--fsize=${outputLimit}`,
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
      workspace.source,
      '/input',
      '--bind',
      workspace.output,
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
      ...typstArguments(workspace.entrypoint, `/output/document.${format}`, format),
    ];

    return this.executeUnit(unit, args, signal);
  }

  private executeUnit(
    unit: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<SandboxExecution> {
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
        // An abort can race transient unit creation; keep killing until systemd-run exits.
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
        } else if (error) {
          stderr += chunk.toString('utf8');
        }
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
