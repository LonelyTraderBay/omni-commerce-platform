import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const isWindows = process.platform === 'win32';
const command = isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm';
const args = isWindows
  ? ['/d', '/s', '/c', 'pnpm --filter @omni/web dev']
  : ['--filter', '@omni/web', 'dev'];

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    NEXT_PUBLIC_UI_PREVIEW: 'true',
  },
  stdio: 'inherit',
  windowsHide: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
