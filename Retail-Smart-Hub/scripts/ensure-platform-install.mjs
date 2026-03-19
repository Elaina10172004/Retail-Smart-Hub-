import fs from 'node:fs';
import path from 'node:path';
import { detectForeignPlatformPackages, ensurePosixExecutable } from './lib/platform-node-modules.mjs';

const root = process.cwd();
const nodeModulesDir = path.join(root, 'node_modules');

const failures = [];

function ensureCliEntry(relativePath) {
  const target = path.join(root, relativePath);
  return fs.existsSync(target);
}

if (!fs.existsSync(nodeModulesDir)) {
  failures.push('node_modules is missing. Run: npm run install:clean');
} else {
  const foreignPackages = detectForeignPlatformPackages(nodeModulesDir);
  if (foreignPackages.length > 0) {
    failures.push(
      `platform-mismatched node_modules detected: ${foreignPackages
        .map((item) => `${item.name} (os=${item.os.join(',') || '*'}, cpu=${item.cpu.join(',') || '*'})`)
        .join(', ')}`,
    );
  }

  if (process.platform === 'win32') {
    if (!ensureCliEntry(path.join('node_modules', '.bin', 'tsx.cmd'))) {
      failures.push('node_modules/.bin/tsx.cmd is missing on this platform');
    }
    if (!ensureCliEntry(path.join('node_modules', '.bin', 'vite.cmd'))) {
      failures.push('node_modules/.bin/vite.cmd is missing on this platform');
    }
  } else {
    if (!ensurePosixExecutable(root, path.join('node_modules', '.bin', 'tsx'))) {
      failures.push('node_modules/.bin/tsx is not executable on this platform');
    }
    if (!ensurePosixExecutable(root, path.join('node_modules', '.bin', 'vite'))) {
      failures.push('node_modules/.bin/vite is not executable on this platform');
    }
  }
}

if (failures.length > 0) {
  console.error('[ensure-platform-install] environment is not runnable on current platform:');
  for (const item of failures) {
    console.error(` - ${item}`);
  }
  console.error('[ensure-platform-install] run "npm run install:clean" and retry.');
  process.exit(1);
}
