import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDockerWatchdog } from './docker-watchdog';
import { AppConfigService } from '../../../config/app-config.service';
import { MAX_PDF_BYTES } from '../domain/compilation';
import {
  SANDBOX_POLICY,
  typstArguments,
  type SandboxExecution,
  type SandboxWorkspace,
  type TypstSandbox,
} from './typst-sandbox';

interface DockerResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  outputLimit: boolean;
}
const POLICY = `typstoria-docker-v3;${SANDBOX_POLICY};nonroot;readonly;network-none;seccomp-builtin;32MiBtmpfs;init;container-timeout30s;host-watchdog30s`;

/** Trusted host worker controls Docker; neither the API nor compiler receives its socket. */
export class DockerTypstSandbox implements TypstSandbox {
  private lastCleanup = 0;
  constructor(private readonly config: AppConfigService) {}

  async fingerprint(): Promise<string> {
    // A detached child still belongs to its parent's systemd cgroup. Do not claim an
    // independent watchdog when service shutdown can terminate both processes.
    if (process.env.INVOCATION_ID)
      throw new Error('Docker watchdog requires supervision outside the worker service cgroup');
    await this.cleanupAbandoned();
    const result = await this.command([
      'image',
      'inspect',
      this.config.typstDockerImage,
      '--format',
      '{{.Id}}',
    ]);
    const id = result.stdout.toString('utf8').trim();
    if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id))
      throw new Error('Pinned compiler image is unavailable');
    return createHash('sha256').update(POLICY).update(id).digest('hex');
  }

  async execute(workspace: SandboxWorkspace, signal?: AbortSignal): Promise<SandboxExecution> {
    const name = `typstoria-compile-${randomUUID()}`;
    const deadline = new AbortController();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), 29_500);
    let watchdog: Awaited<ReturnType<typeof startDockerWatchdog>> | undefined;
    const empty: SandboxExecution = { code: null, stderr: '', timedOut: false, outputLimit: false };
    try {
      if (combined.aborted) return { ...empty, timedOut: true };
      // Wait for create to settle before removing the name, even if cancellation races creation.
      const created = await this.command([
        'create',
        '--pull=never',
        '--name',
        name,
        '--label',
        'typstoria.compiler=true',
        '--init',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--security-opt=seccomp=builtin',
        '--user=1000:1000',
        '--memory=536870912',
        '--memory-swap=536870912',
        '--cpus=1',
        '--pids-limit=32',
        '--ulimit',
        `fsize=${MAX_PDF_BYTES}:${MAX_PDF_BYTES}`,
        '--ulimit',
        'core=0:0',
        '--ulimit',
        'nofile=128:128',
        '--log-driver=none',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777',
        '--tmpfs',
        '/packages:ro,noexec,nosuid,nodev,size=1m,mode=555',
        '--mount',
        `type=bind,source=${workspace.source},target=/input,readonly`,
        '--workdir=/input',
        '--env',
        'HOME=/tmp',
        '--env',
        'LANG=C.UTF-8',
        '--env',
        'SOURCE_DATE_EPOCH=0',
        '--entrypoint=/bin/busybox',
        this.config.typstDockerImage,
        'timeout',
        '-s',
        'KILL',
        '30',
        '/bin/typst',
        ...typstArguments(workspace.entrypoint, '-'),
      ]);
      if (combined.aborted) return { ...empty, timedOut: true };
      if (created.code !== 0) return { ...empty, stderr: created.stderr };
      watchdog = await startDockerWatchdog(
        this.config.typstDockerBinaryPath,
        name,
        30_000,
        this.environment(),
      );
      const result = await this.command(
        ['start', '--attach', name],
        30_000,
        combined,
        MAX_PDF_BYTES,
      );
      if (combined.aborted || result.timedOut) return { ...result, timedOut: true };
      if (result.outputLimit) return result;
      const inspected = await this.command(['inspect', '--format', '{{.State.OOMKilled}}', name]);
      if (inspected.code !== 0) return { ...empty, stderr: inspected.stderr };
      if (inspected.stdout.toString('utf8').trim() === 'true')
        return { ...result, resourceLimit: true };
      if (result.code !== 0) return result;
      // Typst writes PDF to a bounded pipe. The container has no writable host mounts.
      await writeFile(join(workspace.output, 'document.pdf'), result.stdout, {
        flag: 'wx',
        mode: 0o600,
      });
      return result;
    } finally {
      clearTimeout(timer);
      // Killing the CLI alone does not terminate the container's process tree.
      await this.remove(name);
      watchdog?.stop();
    }
  }

  private async cleanupAbandoned(): Promise<void> {
    if (Date.now() - this.lastCleanup < 60_000) return;
    const listed = await this.command([
      'ps',
      '--all',
      '--filter',
      'label=typstoria.compiler=true',
      '--format',
      '{{.Names}}',
    ]);
    if (listed.code !== 0) throw new Error('Compiler runtime is unavailable');
    for (const name of listed.stdout.toString('utf8').trim().split('\n')) {
      if (!/^typstoria-compile-[a-f0-9-]{36}$/.test(name)) continue;
      const inspected = await this.command(['inspect', '--format', '{{.Created}}', name]);
      const created = Date.parse(inspected.stdout.toString('utf8').trim());
      // The container-enforced lifetime is 30s; 90s avoids racing any live attempt.
      if (inspected.code === 0 && Number.isFinite(created) && Date.now() - created > 90_000)
        await this.remove(name);
    }
    this.lastCleanup = Date.now();
  }

  private async remove(name: string): Promise<void> {
    const removed = await this.command(['rm', '--force', name]);
    if (removed.code !== 0 && !/No such container/i.test(removed.stderr))
      throw new Error('Compiler container cleanup failed');
  }

  private environment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH',
      'HOME',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
      'XDG_RUNTIME_DIR',
    ]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    return environment;
  }

  private command(
    args: string[],
    timeoutMs = 5000,
    signal?: AbortSignal,
    stdoutLimit = 256 * 1024,
  ): Promise<DockerResult> {
    return new Promise((resolveResult) => {
      const child = spawn(this.config.typstDockerBinaryPath, args, {
        env: this.environment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let stderrBytes = 0;
      let outputLimit = false;
      let timedOut = false;
      let finished = false;
      const abort = () => {
        timedOut = true;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const collect = (chunk: Buffer, error: boolean) => {
        if (error) stderrBytes += chunk.length;
        else stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutLimit || stderrBytes > 256 * 1024) {
          outputLimit = true;
          child.kill('SIGKILL');
        } else if (error) stderr += chunk.toString('utf8');
        else stdout.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolveResult({ code, stdout: Buffer.concat(stdout), stderr, timedOut, outputLimit });
      };
      child.once('error', () => finish(null));
      child.once('close', finish);
    });
  }
}
