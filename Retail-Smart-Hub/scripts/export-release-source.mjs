import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, 'artifacts', 'source');
const projectDirName = path.basename(projectRoot);

const EXCLUDE_PREFIXES = [
  'archive/',
  'database/',
  'server/database/',
  'release/',
  'artifacts/',
  'node_modules/',
  'dist/',
  'dist-server/',
  'build/',
  'coverage/',
  '.tmp/',
  '.tmp-watch-test/',
  '.vs/',
  '.vscode/',
];

const EXCLUDE_SUBSTRINGS = ['/__pycache__/'];
const EXCLUDE_SUFFIXES = ['.db', '.db-shm', '.db-wal', '.jsonl', '.pyc'];
const EXCLUDE_BASENAMES = new Set(['key.txt']);
const EXCLUDE_BASENAME_PATTERNS = [/^\.env($|\.)/i, /^tmp-.*\.log$/i];

function parseModeArg() {
  const arg = process.argv.find((item) => item.startsWith('--mode='));
  const value = (arg ? arg.slice('--mode='.length) : 'worktree').trim().toLowerCase();
  if (value === 'head' || value === 'worktree') {
    return value;
  }
  throw new Error(`Invalid mode: ${value}. Supported: --mode=worktree | --mode=head`);
}

function resolveGitContext() {
  const gitRoot = execSync('git rev-parse --show-toplevel', {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  const relativeProjectPath = path.relative(gitRoot, projectRoot).replace(/\\/g, '/');
  if (!relativeProjectPath || relativeProjectPath.startsWith('..')) {
    throw new Error('Project path is outside of git root. Cannot export release source.');
  }
  return { gitRoot, relativeProjectPath };
}

function currentRevision(gitRoot) {
  return execSync('git rev-parse --short HEAD', {
    cwd: gitRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

function shouldExclude(projectRelativePath) {
  const normalized = projectRelativePath.replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized);
  if (!normalized || normalized.endsWith('/')) {
    return true;
  }
  if (EXCLUDE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  if (EXCLUDE_SUBSTRINGS.some((snippet) => normalized.includes(snippet))) {
    return true;
  }
  if (EXCLUDE_SUFFIXES.some((suffix) => normalized.toLowerCase().endsWith(suffix))) {
    return true;
  }
  if (EXCLUDE_BASENAMES.has(baseName)) {
    return true;
  }
  if (EXCLUDE_BASENAME_PATTERNS.some((pattern) => pattern.test(baseName))) {
    return true;
  }
  return false;
}

function collectWorktreeFiles() {
  const stdout = execSync('git -C . ls-files --cached --others --exclude-standard', {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !shouldExclude(file))
    .filter((file) => fs.existsSync(path.join(projectRoot, file)));

  if (files.length === 0) {
    throw new Error('No files found for worktree export after applying exclude rules.');
  }
  return files;
}

function exportHeadArchive(archivePath) {
  const { gitRoot, relativeProjectPath } = resolveGitContext();
  const excludePathspecs = EXCLUDE_PREFIXES.map((prefix) => `:(exclude)${relativeProjectPath}/${prefix.replace(/\/$/, '')}`);

  execFileSync(
    'git',
    ['-C', gitRoot, 'archive', '--format=zip', `--output=${archivePath}`, 'HEAD', '--', relativeProjectPath, ...excludePathspecs],
    { stdio: 'inherit' },
  );
}

function exportWorktreeArchive(archivePath) {
  const files = collectWorktreeFiles();
  const tempListPath = path.join(os.tmpdir(), `rsh-source-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const parentDir = path.dirname(projectRoot);
  const prefixedFiles = files.map((file) => `${projectDirName}/${file.replace(/\\/g, '/')}`);
  fs.writeFileSync(tempListPath, `${prefixedFiles.join('\n')}\n`, 'utf8');
  try {
    execFileSync('tar', ['-a', '-cf', archivePath, '-C', parentDir, '-T', tempListPath], {
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(tempListPath, { force: true });
  }
}

function exportSourceArchive() {
  const mode = parseModeArg();
  const { gitRoot } = resolveGitContext();
  const revision = currentRevision(gitRoot);
  const archiveName = `retail-smart-hub-source-${revision}${mode === 'worktree' ? '-worktree' : ''}.zip`;
  const archivePath = path.join(outputDir, archiveName);

  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { force: true });
  }

  if (mode === 'head') {
    exportHeadArchive(archivePath);
  } else {
    exportWorktreeArchive(archivePath);
  }

  console.log(`[release-source] exported ${mode} source bundle: ${path.relative(projectRoot, archivePath)}`);
}

try {
  exportSourceArchive();
} catch (error) {
  console.error(`[release-source] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
