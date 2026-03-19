import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('[clean-install] checking runtime...');
run(process.execPath, [path.join('scripts', 'runtime-check.mjs')]);

console.log('[clean-install] cleaning workspace and node_modules...');
run(process.execPath, [path.join('scripts', 'clean-release-workspace.mjs'), '--with-node-modules']);

console.log('[clean-install] running npm ci...');
run(npmCommand, ['ci']);

console.log('[clean-install] verifying node_modules platform compatibility...');
run(process.execPath, [path.join('scripts', 'ensure-platform-install.mjs')]);

console.log('[clean-install] completed.');
