import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const viteEntry = require.resolve('vite');
const viteCli = resolve(dirname(viteEntry), 'bin/vite.js');
const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const watchers = [
  spawn(process.execPath, [viteCli, 'build', '--watch'], {
    cwd: extensionDirectory,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [viteCli, 'build', '--mode', 'content-script', '--watch'], {
    cwd: extensionDirectory,
    stdio: 'inherit',
  }),
];

let stopping = false;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const watcher of watchers) {
    if (watcher.exitCode === null) watcher.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0));
}

for (const watcher of watchers) {
  watcher.on('error', (error) => {
    console.error('Failed to start Vite watcher:', error);
    stop(1);
  });
  watcher.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
