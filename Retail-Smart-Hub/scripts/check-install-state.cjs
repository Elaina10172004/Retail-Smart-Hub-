const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeMap(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, version]) => [key, String(version)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function mapsEqual(left, right) {
  return JSON.stringify(normalizeMap(left)) === JSON.stringify(normalizeMap(right));
}

function main() {
  const cwd = process.cwd();
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageLockPath = path.join(cwd, 'package-lock.json');

  if (!fs.existsSync(packageJsonPath)) {
    console.error('package.json not found');
    process.exit(1);
  }

  const pkg = readJson(packageJsonPath);
  const pkgDependencies = pkg.dependencies || {};
  const pkgDevDependencies = pkg.devDependencies || {};

  let lockRoot = null;
  if (fs.existsSync(packageLockPath)) {
    const lock = readJson(packageLockPath);
    lockRoot = lock.packages && lock.packages[''] ? lock.packages[''] : null;
  }

  const missing = [];
  const packageNames = Array.from(
    new Set([...Object.keys(pkgDependencies), ...Object.keys(pkgDevDependencies)]),
  ).sort((left, right) => left.localeCompare(right));

  for (const name of packageNames) {
    const packagePath = path.join(cwd, 'node_modules', ...name.split('/'), 'package.json');
    if (!fs.existsSync(packagePath)) {
      missing.push(name);
    }
  }

  const lockMismatch =
    !lockRoot ||
    !mapsEqual(lockRoot.dependencies, pkgDependencies) ||
    !mapsEqual(lockRoot.devDependencies, pkgDevDependencies);

  if (lockMismatch) {
    console.log('__LOCK_STALE__');
  }

  if (missing.length > 0) {
    console.log(`__MISSING__ ${missing.join(', ')}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
