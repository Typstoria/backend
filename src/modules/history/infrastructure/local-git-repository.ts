import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { normalizedProjectPath } from '../../projects/domain/text-changes';
import {
  serializeSnapshotManifest,
  snapshotManifestHash,
} from '../../revisions/domain/snapshot-manifest';
import { GitHistoryError, GitRepository, type GitRevisionInput } from '../domain/git-history';

interface TreeNode {
  children: Map<string, TreeNode>;
  sha?: string;
}
const ZERO = '0'.repeat(40);
const SHA = /^[a-f0-9]{40}$/;

/** Git plumbing only: no worktree, filters, hooks, remotes, user config or shell. */
@Injectable()
export class LocalGitRepository extends GitRepository {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  async write(input: GitRevisionInput, signal?: AbortSignal): Promise<string> {
    if (snapshotManifestHash(input) !== input.manifestHash)
      throw new GitHistoryError('MANIFEST_MISMATCH');
    const repo = this.repository(input.ownerId, input.projectId);
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await this.run(
      repo,
      ['init', '--bare', '--object-format=sha1', '--initial-branch=main', '--template=', repo],
      undefined,
      signal,
    );
    const tree: TreeNode = { children: new Map() };
    const objects = new Map<string, string>();
    const add = (path: string, sha: string) => {
      const segments = path.split('/');
      let node = tree;
      for (const segment of segments) {
        let child = node.children.get(segment);
        if (!child) {
          child = { children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.sha = sha;
    };
    for (const file of input.files) {
      const path = normalizedProjectPath(file.path);
      let sha = objects.get(file.sha256);
      if (!sha) {
        sha = this.sha(
          await this.run(
            repo,
            ['hash-object', '-w', '--no-filters', '--stdin'],
            file.bytes,
            signal,
          ),
        );
        objects.set(file.sha256, sha);
      }
      add(path, sha);
    }
    const manifest = Buffer.from(serializeSnapshotManifest(input), 'utf8');
    add(
      '.typstoria/manifest.json',
      this.sha(
        await this.run(repo, ['hash-object', '-w', '--no-filters', '--stdin'], manifest, signal),
      ),
    );
    const writeTree = async (node: TreeNode): Promise<string> => {
      const records: Buffer[] = [];
      for (const [name, child] of node.children) {
        const sha = child.sha ?? (await writeTree(child));
        records.push(
          Buffer.from(`${child.sha ? '100644 blob' : '040000 tree'} ${sha}\t${name}\0`, 'utf8'),
        );
      }
      return this.sha(await this.run(repo, ['mktree', '-z'], Buffer.concat(records), signal));
    };
    const treeSha = await writeTree(tree);
    const revision = input.revision;
    const timestamp = `${Math.floor(revision.createdAt.getTime() / 1000)} +0000`;
    const message = `${revision.summary}\n\nTypstoria-Project: ${input.projectId}\nTypstoria-Revision: ${revision.id}\nTypstoria-Manifest: ${input.manifestHash}\nTypstoria-Operation: ${revision.operation}\nTypstoria-Channel: ${revision.channel}\n`;
    const sha = this.sha(
      await this.run(
        repo,
        ['commit-tree', treeSha, ...(input.parentSha ? ['-p', this.sha(input.parentSha)] : [])],
        Buffer.from(message),
        signal,
        {
          GIT_AUTHOR_NAME: `User ${revision.actorId}`,
          GIT_AUTHOR_EMAIL: `user-${revision.actorId}@typstoria.invalid`,
          GIT_COMMITTER_NAME: 'Typstoria',
          GIT_COMMITTER_EMAIL: 'history@typstoria.invalid',
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_DATE: timestamp,
        },
      ),
    );
    if (input.expectedCommitSha && input.expectedCommitSha !== sha)
      throw new GitHistoryError('MANIFEST_MISMATCH');
    const ref = `refs/typstoria/revisions/${revision.id}`;
    const previous = await this.ref(repo, ref, signal);
    const head = await this.ref(repo, 'refs/heads/main', signal);
    if (previous && previous !== sha) throw new GitHistoryError('GIT_DIVERGED');
    if (head === sha && previous === sha) return sha;
    if (head !== input.parentSha && head !== sha) {
      if (previous === sha && head && !input.latest) {
        try {
          await this.run(repo, ['merge-base', '--is-ancestor', sha, head], undefined, signal);
          return sha;
        } catch {
          throw new GitHistoryError('GIT_DIVERGED');
        }
      }
      throw new GitHistoryError('GIT_DIVERGED');
    }
    const commands = [
      'start',
      previous ? `verify ${ref} ${sha}` : `create ${ref} ${sha}`,
      `update refs/heads/main ${sha} ${head ?? ZERO}`,
      'prepare',
      'commit',
      '',
    ];
    await this.run(repo, ['update-ref', '--stdin'], Buffer.from(commands.join('\n')), signal);
    return sha;
  }

  private repository(ownerId: number, projectId: number): string {
    if (![ownerId, projectId].every((id) => Number.isInteger(id) && id > 0 && id <= 2147483647))
      throw new GitHistoryError('GIT_UNAVAILABLE');
    return join(resolve(this.config.gitStoragePath), String(ownerId), `${projectId}.git`);
  }
  private sha(value: string): string {
    const sha = value.trim();
    if (!SHA.test(sha)) throw new GitHistoryError('GIT_UNAVAILABLE');
    return sha;
  }
  private async ref(repo: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    try {
      return this.sha(
        await this.run(repo, ['show-ref', '--verify', '--hash', ref], undefined, signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  private run(
    repo: string,
    args: string[],
    input?: Buffer,
    signal?: AbortSignal,
    extra: Record<string, string> = {},
  ): Promise<string> {
    return new Promise((done, fail) => {
      const child = spawn(
        resolve(this.config.gitBinaryPath),
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.attributesFile=/dev/null',
          '-c',
          'protocol.allow=never',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          '-c',
          'commit.gpgsign=false',
          '--git-dir',
          repo,
          ...args,
        ],
        {
          detached: true,
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            HOME: '/nonexistent',
            XDG_CONFIG_HOME: '/nonexistent',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            ...extra,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let bytes = 0;
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
        }
      };
      const timer = setTimeout(kill, 10_000);
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) kill();
        else output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) kill();
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
      child.once('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        fail(new GitHistoryError('GIT_UNAVAILABLE'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        if (code === 0 && !signal?.aborted) done(output);
        else fail(new GitHistoryError('GIT_UNAVAILABLE'));
      });
    });
  }
}
