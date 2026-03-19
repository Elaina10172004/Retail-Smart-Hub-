import { execSync } from 'node:child_process';

const MIN_NODE = [22, 14, 0];
const MAX_NODE_MAJOR = 24;
const MIN_NPM = [10, 9, 2];

function parseVersion(version) {
  const normalized = version.trim().replace(/^v/, '');
  const [major = 0, minor = 0, patch = 0] = normalized.split('.').map((value) => Number.parseInt(value, 10) || 0);
  return [major, minor, patch];
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] || 0;
    const r = right[index] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function formatVersion(version) {
  return version.join('.');
}

function assertRuntime() {
  const nodeVersion = parseVersion(process.version);
  if (compareVersion(nodeVersion, MIN_NODE) < 0 || nodeVersion[0] > MAX_NODE_MAJOR) {
    throw new Error(
      `[runtime-check] Node.js version mismatch. Required: >=${formatVersion(MIN_NODE)} and <=${MAX_NODE_MAJOR}.x, current: ${process.version}`,
    );
  }

  const npmVersionRaw = execSync('npm --version', { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const npmVersion = parseVersion(npmVersionRaw);
  if (compareVersion(npmVersion, MIN_NPM) < 0) {
    throw new Error(
      `[runtime-check] npm version mismatch. Required: >=${formatVersion(MIN_NPM)}, current: ${npmVersionRaw}`,
    );
  }

  console.log(`[runtime-check] Node ${process.version} / npm ${npmVersionRaw}`);
}

try {
  assertRuntime();
} catch (error) {
  console.error(error instanceof Error ? error.message : '[runtime-check] Unknown runtime validation error');
  process.exit(1);
}
