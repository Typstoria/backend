import { spawn } from 'node:child_process';

/** Standalone trusted host supervisor. Receives no document content or application secrets. */
const [binary, name, deadlineText] = process.argv.slice(2);
const deadline = Number(deadlineText);
if (
  !binary ||
  !name ||
  !/^typstoria-compile-[a-f0-9-]{36}$/.test(name) ||
  !Number.isFinite(deadline)
)
  process.exit(1);

function remove() {
  const child = spawn(binary!, ['rm', '--force', name!], { env: process.env, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let finished = false;
  const done = (code: number | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (code === 0 || Date.now() > deadline + 60_000) process.exit();
    setTimeout(remove, 200);
  };
  child.once('error', () => done(null));
  child.once('close', done);
}
setTimeout(remove, Math.max(0, deadline - Date.now()));
process.send?.('ready');
process.disconnect?.();
