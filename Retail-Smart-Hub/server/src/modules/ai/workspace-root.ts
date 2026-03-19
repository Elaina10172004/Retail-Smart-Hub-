import fs from 'node:fs';
import path from 'node:path';

function normalizeCandidate(value: string) {
  return path.resolve(value);
}

function hasDocsKnowledgeRoot(root: string) {
  return fs.existsSync(path.join(root, 'docs', 'rag', 'knowledge'));
}

function hasAppRoot(root: string) {
  return fs.existsSync(path.join(root, 'Retail-Smart-Hub', 'package.json'));
}

function looksLikeWorkspaceRoot(root: string) {
  return hasDocsKnowledgeRoot(root) || (fs.existsSync(path.join(root, 'docs')) && hasAppRoot(root));
}

function collectCandidates(start: string) {
  const candidates: string[] = [];
  let current = normalizeCandidate(start);

  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidates.includes(current)) {
      candidates.push(current);
    }
    const parent = path.resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return candidates;
}

export function resolveWorkspaceRoot(startDir = process.cwd()) {
  const explicit = process.env.RETAIL_SMART_HUB_WORKSPACE_ROOT?.trim();
  if (explicit) {
    const candidate = normalizeCandidate(explicit);
    if (looksLikeWorkspaceRoot(candidate)) {
      return candidate;
    }
  }

  const candidates = collectCandidates(startDir);
  const workspaceRoot = candidates.find((candidate) => looksLikeWorkspaceRoot(candidate));
  if (workspaceRoot) {
    return workspaceRoot;
  }

  const appRoot = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (appRoot) {
    const parent = path.resolve(appRoot, '..');
    if (hasDocsKnowledgeRoot(parent)) {
      return parent;
    }
  }

  return normalizeCandidate(startDir);
}

export function resolveWorkspaceDocsRoot(startDir = process.cwd()) {
  return path.join(resolveWorkspaceRoot(startDir), 'docs');
}
