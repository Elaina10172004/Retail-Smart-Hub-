import fs from 'node:fs';
import path from 'node:path';

const PLATFORM_PACKAGE_PATTERNS = [
  /^@esbuild\//,
  /^@rollup\/rollup-/,
  /^@swc\/core-/,
  /^@img\/sharp-/,
  /^@tailwindcss\/oxide-/,
];

function normalizeOsToken(token) {
  const value = token.toLowerCase();
  if (value === 'windows') return 'win32';
  if (value === 'macos') return 'darwin';
  return value;
}

function listTopLevelPackageNames(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }

  const names = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    if (entry.name.startsWith('@')) {
      const scopedDir = path.join(nodeModulesDir, entry.name);
      for (const child of fs.readdirSync(scopedDir, { withFileTypes: true })) {
        if (child.isDirectory()) {
          names.push(`${entry.name}/${child.name}`);
        }
      }
      continue;
    }

    names.push(entry.name);
  }

  return names;
}

function resolvePackageJsonPath(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split('/'), 'package.json');
}

function readPackageManifest(nodeModulesDir, packageName) {
  const manifestPath = resolvePackageJsonPath(nodeModulesDir, packageName);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function matchesConstraint(constraints, currentToken) {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    return true;
  }

  const normalized = constraints
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .map((item) => normalizeOsToken(item));
  if (normalized.length === 0) {
    return true;
  }

  const positive = normalized.filter((item) => !item.startsWith('!'));
  const negative = normalized
    .filter((item) => item.startsWith('!'))
    .map((item) => item.slice(1));

  if (negative.includes(currentToken)) {
    return false;
  }

  if (positive.length === 0) {
    return true;
  }

  return positive.includes(currentToken);
}

export function detectForeignPlatformPackages(nodeModulesDir, runtime = { platform: process.platform, arch: process.arch }) {
  const currentPlatform = normalizeOsToken(runtime.platform);
  const currentArch = runtime.arch;
  const mismatched = [];

  const packageNames = listTopLevelPackageNames(nodeModulesDir);
  for (const packageName of packageNames) {
    if (!PLATFORM_PACKAGE_PATTERNS.some((pattern) => pattern.test(packageName))) {
      continue;
    }

    const manifest = readPackageManifest(nodeModulesDir, packageName);
    if (!manifest) {
      continue;
    }

    const osSupported = matchesConstraint(manifest.os, currentPlatform);
    const cpuSupported = matchesConstraint(manifest.cpu, currentArch);
    if (!osSupported || !cpuSupported) {
      mismatched.push({
        name: packageName,
        os: Array.isArray(manifest.os) ? manifest.os : [],
        cpu: Array.isArray(manifest.cpu) ? manifest.cpu : [],
      });
    }
  }

  return mismatched;
}

export function ensurePosixExecutable(rootDir, relativePath) {
  if (process.platform === 'win32') {
    return true;
  }

  const target = path.join(rootDir, relativePath);
  if (!fs.existsSync(target)) {
    return false;
  }

  const stat = fs.statSync(target);
  const mode = stat.mode;
  if (mode & 0o111) {
    return true;
  }

  try {
    fs.chmodSync(target, mode | 0o755);
    const patchedMode = fs.statSync(target).mode;
    return Boolean(patchedMode & 0o111);
  } catch {
    return false;
  }
}
