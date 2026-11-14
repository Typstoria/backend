import { spawn } from 'node:child_process';

import { extname, join } from 'node:path';

export function startDockerWatchdog(
  binary: string,
  name: string,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<{ stop(): void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(__dirname, 'docker-watchdog-process' + extname(__filename)),
        binary,
        name,
        String(Date.now() + timeoutMs),
      ],
      {
        env: environment,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Compiler watchdog did not start'));
    }, 3000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('Compiler watchdog is unavailable'));
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.once('message', (message) => {
      if (message !== 'ready') return;
      clearTimeout(timer);
      child.removeListener('exit', fail);
      child.unref();
      resolve({
        stop: () => {
          child.kill('SIGTERM');
        },
      });
    });
  });
}
