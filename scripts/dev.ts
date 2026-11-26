// Starts the API (restarts on change) and the Vite dashboard together.
//   npm run dev            -> http://localhost:5173 (landing page; dashboard on /app/; proxies /api to :8787)
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';
const children: ChildProcess[] = [];

function run(name: string, color: number, cmd: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '1', ...env }, shell: isWin });
  const tag = `\x1b[${color}m${name.padEnd(9)}\x1b[0m│ `;
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = '';
    stream?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) process.stdout.write(tag + l + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', code => {
    process.stdout.write(`${tag}exited with ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const port = process.env.PORT ?? '8787';
run('server', 35, process.execPath, ['--watch-path=apps/server/src', '--watch-path=packages/guard/src', 'apps/server/src/main.ts'], { PORT: port });
run('dashboard', 36, isWin ? 'npm.cmd' : 'npm', ['run', 'dev', '-w', '@oakenshield/dashboard'], { PORT: port });
