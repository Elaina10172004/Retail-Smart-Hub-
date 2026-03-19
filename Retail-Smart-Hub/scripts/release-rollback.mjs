import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseArg(name, fallback) {
  const raw = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!raw) {
    return fallback;
  }
  const value = raw.slice(name.length + 3).trim();
  return value || fallback;
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}`);
  }
}

function runCapture(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(stderr || `command failed: ${command} ${args.join(' ')}`);
  }
  return String(result.stdout || '').trim();
}

function ensureExists(filePath, message) {
  if (!fs.existsSync(filePath)) {
    throw new Error(message);
  }
}

const ref = parseArg('ref', 'HEAD~1');
const outputRoot = path.resolve(root, parseArg('output', path.join('artifacts', 'rollback')));
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const safeRef = ref.replace(/[^a-zA-Z0-9_.-]/g, '_');
const artifactDir = path.join(outputRoot, `${safeRef}-${timestamp}`);
const tempWorktree = path.join(os.tmpdir(), `rsh-rollback-${safeRef}-${Date.now()}`);

console.log(`[rollback] target ref: ${ref}`);
console.log(`[rollback] output dir: ${artifactDir}`);

try {
  runCapture('git', ['rev-parse', '--verify', ref], root);
  run('git', ['worktree', 'add', '--detach', tempWorktree, ref], root);

  run(process.execPath, ['scripts/runtime-check.mjs'], tempWorktree);
  run(npmCommand, ['ci'], tempWorktree);
  run(npmCommand, ['run', 'release:ci'], tempWorktree);

  const sourceArtifacts = path.join(tempWorktree, 'artifacts');
  ensureExists(sourceArtifacts, '[rollback] release artifacts not found in rollback worktree');

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.cpSync(sourceArtifacts, artifactDir, { recursive: true, force: true });

  const manifest = {
    ref,
    generatedAt: new Date().toISOString(),
    sourceWorktree: tempWorktree,
    outputDir: artifactDir,
    note: 'Rollback artifacts generated from historical ref. Promote these artifacts to recover the previous release.',
  };
  fs.writeFileSync(path.join(artifactDir, 'rollback-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('[rollback] rollback artifacts generated successfully.');
} finally {
  if (fs.existsSync(tempWorktree)) {
    try {
      run('git', ['worktree', 'remove', '--force', tempWorktree], root);
    } catch (error) {
      console.warn(
        `[rollback] failed to remove temp worktree (${tempWorktree}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
