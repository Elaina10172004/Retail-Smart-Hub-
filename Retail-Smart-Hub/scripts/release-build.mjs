import { spawnSync } from 'node:child_process';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isCiMode = process.argv.includes('--ci');

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

console.log('[release] step 1/10 runtime check');
run(process.execPath, ['scripts/runtime-check.mjs']);

console.log('[release] step 2/10 clean stale outputs');
run(process.execPath, ['scripts/clean-release-workspace.mjs', '--with-node-modules']);

console.log('[release] step 3/10 clean install');
run(npmCommand, ['ci']);

console.log('[release] step 4/10 install python-agent dependencies');
run(npmCommand, ['run', 'python:deps:install']);

console.log('[release] step 5/10 test');
run(npmCommand, ['run', 'test']);

console.log('[release] step 6/10 preflight guard (before build)');
run(process.execPath, ['scripts/release-preflight.mjs']);

console.log('[release] step 7/10 build web/server');
run(npmCommand, ['run', 'build']);

console.log('[release] step 8/10 preflight guard (after build)');
run(process.execPath, ['scripts/release-preflight.mjs']);

console.log(`[release] step 9/10 electron package (${isCiMode ? 'dir' : 'installer'})`);
if (isCiMode) {
  run(npmCommand, ['exec', 'electron-builder', '--', '--dir', '--publish', 'never']);
} else {
  run(npmCommand, ['exec', 'electron-builder', '--', '--publish', 'never']);
}

console.log('[release] step 10/10 export clean source bundle');
run(process.execPath, ['scripts/export-release-source.mjs']);

console.log('[release] completed. Artifacts are under artifacts/.');
