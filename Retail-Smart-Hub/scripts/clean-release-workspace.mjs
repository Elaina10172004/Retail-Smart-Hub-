import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const includeNodeModules = args.has('--with-node-modules');

const CLEAN_TARGETS = [
  'dist',
  'dist-server',
  'release',
  path.join('artifacts', 'desktop'),
  path.join('artifacts', 'source'),
  '.tmp-watch-test',
  path.join('python-agent', '.venv'),
  path.join('python-agent', 'venv'),
];
if (includeNodeModules) {
  CLEAN_TARGETS.push('node_modules');
}
const cleanupTrashRoot = path.join(os.tmpdir(), 'retail-smart-hub-cleanup');

function moveToExternalTrash(targetPath) {
  fs.mkdirSync(cleanupTrashRoot, { recursive: true });
  const name = path.basename(targetPath);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const quarantinePath = path.join(cleanupTrashRoot, `${name}.${suffix}`);
  fs.renameSync(targetPath, quarantinePath);
  try {
    fs.rmSync(quarantinePath, { recursive: true, force: true });
  } catch {
    // Best effort only; quarantine is outside workspace now.
  }
}

function safeRemove(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const isDirectory = fs.statSync(targetPath).isDirectory();
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // fallback below
  }

  if (fs.existsSync(targetPath)) {
    try {
      moveToExternalTrash(targetPath);
    } catch {
      // keep trying below
    }
  }

  if (fs.existsSync(targetPath) && process.platform === 'win32') {
    if (isDirectory) {
      spawnSync('cmd.exe', ['/d', '/s', '/c', `rmdir /s /q "${targetPath}"`], { stdio: 'ignore' });
    } else {
      spawnSync('cmd.exe', ['/d', '/s', '/c', `del /f /q "${targetPath}"`], { stdio: 'ignore' });
    }
  }

  if (fs.existsSync(targetPath)) {
    throw new Error(`[clean-release] failed to remove ${path.relative(root, targetPath)}. File may be locked by another process.`);
  }

  console.log(`[clean-release] removed ${path.relative(root, targetPath)}`);
}

function removeDatabaseArtifacts(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeDatabaseArtifacts(entryPath);
      continue;
    }

    if (/\.(db|db-shm|db-wal)$/i.test(entry.name)) {
      safeRemove(entryPath);
    }
  }
}

function removeCleanupFragments(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.includes('.cleanup-')) {
      continue;
    }
    safeRemove(path.join(directory, entry.name));
  }
}

for (const target of CLEAN_TARGETS) {
  safeRemove(path.join(root, target));
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /^tmp-.*\.log$/i.test(entry.name)) {
    safeRemove(path.join(root, entry.name));
  }
}

removeDatabaseArtifacts(path.join(root, 'database'));
safeRemove(path.join(root, 'database', 'rag'));
removeDatabaseArtifacts(path.join(root, 'server', 'database'));
removeCleanupFragments(root);
removeCleanupFragments(path.join(root, 'database'));
removeCleanupFragments(path.join(root, 'server', 'database'));

console.log('[clean-release] workspace clean complete.');
