import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectForeignPlatformPackages } from './lib/platform-node-modules.mjs';

const root = process.cwd();
const LOCKFILE_NAME = 'package-lock.json';

const SECRET_PATHS = ['key.txt'];
const STALE_OUTPUTS = ['release', path.join('artifacts', 'desktop'), path.join('artifacts', 'source')];
const FORBIDDEN_WORKSPACE_DIRS = ['.vs', '.vscode', '.tmp-watch-test'];
const FORBIDDEN_WORKSPACE_FILE_PATTERNS = [/^tmp-.*\.log$/i];
const FORBIDDEN_TRACKED_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^dist-server\//,
  /^release\//,
  /^artifacts\/desktop\//,
  /^artifacts\/source\//,
  /^\.vs\//,
  /^\.vscode\//,
  /^database\/.*\.(db|db-shm|db-wal)$/i,
  /^database\/.*\.jsonl$/i,
  /^database\/rag\//i,
  /^server\/database\/.*\.(db|db-shm|db-wal)$/i,
  /^\.env(?:$|\.(?!example$).+)/i,
  /^key\.txt$/i,
  /^tmp-.*\.log$/i,
];
const REQUIRED_BUNDLED_SKILLS = ['controlled-write', 'retrieval-analyst'];

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function detectEnvSecrets() {
  const envFiles = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith('.env')) {
      continue;
    }
    if (entry.name === '.env.example') {
      continue;
    }
    envFiles.push(entry.name);
  }
  return envFiles;
}

function collectDatabaseArtifacts(directory) {
  const results = [];
  if (!fs.existsSync(directory)) {
    return results;
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDatabaseArtifacts(fullPath));
      continue;
    }
    const relativePath = path.relative(root, fullPath);
    if (/\.(db|db-shm|db-wal|jsonl)$/i.test(entry.name) || relativePath.startsWith(`database${path.sep}rag${path.sep}`)) {
      results.push(relativePath);
    }
  }
  return results;
}

function gitTrackedFiles() {
  try {
    const output = execSync('git ls-files', { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function validateElectronBuilderConfig() {
  const packageJsonPath = path.join(root, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return ['package.json not found'];
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const build = packageJson.build || {};
  const outputDir = String(build?.directories?.output || '');
  const files = Array.isArray(build?.files) ? build.files : [];
  const issues = [];

  if (!outputDir.startsWith('artifacts/')) {
    issues.push(`electron-builder output must be under artifacts/, current: ${outputDir || '(empty)'}`);
  }

  if (files.length === 0) {
    issues.push('electron-builder files whitelist is empty');
  }

  if (files.some((entry) => entry === '**/*' || entry === '*')) {
    issues.push('electron-builder files uses broad wildcard (* or **/*), which can include unwanted files');
  }

  const forbiddenPackEntries = ['.git', '.vs', '.vscode', 'node_modules', '.env', 'key.txt', 'database'];
  const matchedForbidden = files.filter((entry) =>
    forbiddenPackEntries.some((forbidden) => String(entry).includes(forbidden)),
  );
  if (matchedForbidden.length > 0) {
    issues.push(`electron-builder files contains forbidden entries: ${matchedForbidden.join(', ')}`);
  }

  return issues;
}

function validateBundledSkillsAssets() {
  const issues = [];
  const sourceRoot = path.join(root, 'server', 'src', 'modules', 'ai', 'skills-builtin');
  if (!fs.existsSync(sourceRoot)) {
    issues.push('bundled skills source directory is missing: server/src/modules/ai/skills-builtin');
    return issues;
  }

  for (const skillId of REQUIRED_BUNDLED_SKILLS) {
    const sourceSkillFile = path.join(sourceRoot, skillId, 'SKILL.md');
    if (!fs.existsSync(sourceSkillFile)) {
      issues.push(`missing bundled skill asset: server/src/modules/ai/skills-builtin/${skillId}/SKILL.md`);
    }
  }

  const distRoot = path.join(root, 'dist-server', 'modules', 'ai', 'skills-builtin');
  if (fs.existsSync(path.join(root, 'dist-server'))) {
    for (const skillId of REQUIRED_BUNDLED_SKILLS) {
      const distSkillFile = path.join(distRoot, skillId, 'SKILL.md');
      if (!fs.existsSync(distSkillFile)) {
        issues.push(`dist-server exists but bundled skill was not copied: dist-server/modules/ai/skills-builtin/${skillId}/SKILL.md`);
      }
    }
  }

  return issues;
}

function runRuntimeCheck() {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'runtime-check.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
}

function runAiPythonFreezeGuard() {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'guard-ai-python-first.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
}

function runInstallReadinessCheck() {
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'ensure-platform-install.mjs')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (error) {
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
    const details = [stdout, stderr]
      .join('\n')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' | ');
    return details || 'ensure-platform-install failed';
  }
}

function gitHasRepo() {
  try {
    const output = execSync('git rev-parse --is-inside-work-tree', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    return output === 'true';
  } catch {
    return false;
  }
}

function gitDirtyEntries() {
  try {
    const output = execSync('git status --porcelain', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const failures = [];

try {
  runRuntimeCheck();
  runAiPythonFreezeGuard();
} catch {
  process.exit(1);
}

for (const envSecret of detectEnvSecrets()) {
  failures.push(`secret file exists: ${envSecret}`);
}

if (!exists(LOCKFILE_NAME)) {
  failures.push(`${LOCKFILE_NAME} is missing. Run npm install to generate it and commit the file.`);
}

for (const secretPath of SECRET_PATHS) {
  if (exists(secretPath)) {
    failures.push(`secret file exists: ${secretPath}`);
  }
}

for (const stalePath of STALE_OUTPUTS) {
  if (exists(stalePath)) {
    failures.push(`stale build output exists: ${stalePath}`);
  }
}

for (const forbiddenDir of FORBIDDEN_WORKSPACE_DIRS) {
  if (exists(forbiddenDir)) {
    failures.push(`forbidden workspace directory exists: ${forbiddenDir}`);
  }
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile()) {
    continue;
  }
  if (FORBIDDEN_WORKSPACE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
    failures.push(`forbidden workspace file exists: ${entry.name}`);
  }
}

const dbArtifacts = [
  ...collectDatabaseArtifacts(path.join(root, 'database')),
  ...collectDatabaseArtifacts(path.join(root, 'server', 'database')),
];
if (dbArtifacts.length > 0) {
  failures.push(`database artifacts detected: ${dbArtifacts.join(', ')}`);
}

const trackedFiles = gitTrackedFiles();
if (trackedFiles.length > 0 && !trackedFiles.includes(LOCKFILE_NAME)) {
  failures.push(`${LOCKFILE_NAME} is not tracked by git.`);
}
const forbiddenTracked = trackedFiles.filter((filePath) =>
  FORBIDDEN_TRACKED_PATTERNS.some((pattern) => pattern.test(filePath)),
);
if (forbiddenTracked.length > 0) {
  failures.push(`forbidden tracked files: ${forbiddenTracked.join(', ')}`);
}

const nodeModulesDir = path.join(root, 'node_modules');
if (!fs.existsSync(nodeModulesDir)) {
  failures.push('node_modules is missing. Run npm ci before release preflight.');
} else {
  const foreignPackages = detectForeignPlatformPackages(nodeModulesDir);
  if (foreignPackages.length > 0) {
    failures.push(
      `platform-mismatched node_modules detected: ${foreignPackages
        .map((item) => `${item.name} (os=${item.os.join(',') || '*'}, cpu=${item.cpu.join(',') || '*'})`)
        .join(', ')}`,
    );
  }

  const installReadinessError = runInstallReadinessCheck();
  if (installReadinessError) {
    failures.push(`node_modules is not runnable on this platform: ${installReadinessError}`);
  }
}

if (gitHasRepo()) {
  const dirtyEntries = gitDirtyEntries();
  if (dirtyEntries.length > 0) {
    failures.push(`workspace is dirty. Commit/stash before release: ${dirtyEntries.slice(0, 20).join(' | ')}`);
  }
}

failures.push(...validateElectronBuilderConfig());
failures.push(...validateBundledSkillsAssets());

if (failures.length > 0) {
  console.error('[release-preflight] failed:');
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log('[release-preflight] passed.');
