import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../../shared/api-error';
import { createHash } from 'node:crypto';
import { resolveWorkspaceRoot } from './workspace-root';

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.csv']);
const DEFAULT_UPLOAD_DIR = 'docs/rag/knowledge';
const ROOT_KNOWLEDGE_FILES = new Set<string>();
const KNOWLEDGE_SETTINGS_FILE = 'knowledge-document-settings.json';

type RegisteredSourceMeta = {
  docId: string;
  docTitle?: string;
  sourceType: string;
  moduleId: string;
  scopeType: string;
};

interface KnowledgeDocumentSettings {
  version: number;
  updatedAt: string;
  includeInAssistant: Record<string, boolean>;
}

export interface LocalKnowledgeDocumentSummary {
  key: string;
  relativePath: string;
  fileName: string;
  directory: string;
  extension: string;
  source: 'docs' | 'root';
  size: number;
  updatedAt: string;
  isRegisteredSource: boolean;
  includeInAssistant: boolean;
  docId?: string;
  docTitle?: string;
  sourceType?: string;
  moduleId?: string;
  scopeType?: string;
}

export interface LocalKnowledgeDocumentDetail {
  document: LocalKnowledgeDocumentSummary;
  content: string;
  lineCount: number;
}

interface ResolvedDocumentPath {
  workspaceRoot: string;
  docsRoot: string;
  relativePath: string;
  absolutePath: string;
  source: 'docs' | 'root';
}

interface PatchLocalKnowledgeDocumentInput {
  content?: string;
  includeInAssistant?: boolean;
}

function getWorkspaceRoot() {
  return resolveWorkspaceRoot();
}

function getDocsRoot(workspaceRoot: string) {
  return path.resolve(workspaceRoot, 'docs');
}

function getDataRoot() {
  const configuredRoot = process.env.RETAIL_SMART_HUB_DATA_DIR?.trim();
  const dataRoot = configuredRoot ? path.resolve(configuredRoot) : path.resolve(process.cwd(), 'database');
  fs.mkdirSync(dataRoot, { recursive: true });
  return dataRoot;
}

function getKnowledgeSettingsPath() {
  const ragDir = path.join(getDataRoot(), 'rag');
  fs.mkdirSync(ragDir, { recursive: true });
  return path.join(ragDir, KNOWLEDGE_SETTINGS_FILE);
}

function normalizeRelativePath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function toRelativePath(workspaceRoot: string, absolutePath: string) {
  return normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
}

function hasAllowedExtension(filePath: string) {
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function encodeDocumentKey(relativePath: string) {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function decodeDocumentKey(key: string) {
  try {
    return Buffer.from(key, 'base64url').toString('utf8');
  } catch {
    throw new ApiError(400, 'Invalid document key', 'INVALID_DOCUMENT_KEY');
  }
}

function ensureSafeRelativePath(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.includes('\0') || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new ApiError(400, 'Invalid document path', 'INVALID_DOCUMENT_PATH');
  }
  return normalized;
}

function resolveManagedDocumentPath(relativePathInput: string): ResolvedDocumentPath {
  const workspaceRoot = getWorkspaceRoot();
  const docsRoot = getDocsRoot(workspaceRoot);
  const relativePath = ensureSafeRelativePath(relativePathInput);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const extension = path.extname(absolutePath).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ApiError(415, `Unsupported document extension: ${extension || '(none)'}`, 'UNSUPPORTED_DOCUMENT_EXTENSION');
  }

  if (absolutePath.startsWith(`${docsRoot}${path.sep}`)) {
    return {
      workspaceRoot,
      docsRoot,
      relativePath,
      absolutePath,
      source: 'docs',
    };
  }

  if (path.dirname(relativePath) === '.' && ROOT_KNOWLEDGE_FILES.has(path.basename(relativePath))) {
    return {
      workspaceRoot,
      docsRoot,
      relativePath,
      absolutePath,
      source: 'root',
    };
  }

  throw new ApiError(400, 'Document path is out of managed scope', 'DOCUMENT_SCOPE_FORBIDDEN');
}

function collectDocsFiles(rootDir: string, output: string[]) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectDocsFiles(absolutePath, output);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!hasAllowedExtension(entry.name)) {
      continue;
    }
    output.push(absolutePath);
  }
}

function buildDocumentId(relativePath: string) {
  return createHash('sha1').update(normalizeRelativePath(relativePath), 'utf8').digest('hex').slice(0, 16);
}

function inferSourceType(fileName: string) {
  const lowered = fileName.toLowerCase();
  if ((lowered.includes('api') && lowered.includes('catalog')) || fileName.includes('接口')) {
    return 'api_spec';
  }
  if (lowered.includes('table') || fileName.includes('数据表') || fileName.includes('数据库')) {
    return 'db_spec';
  }
  if (lowered.includes('report') || fileName.includes('报表')) {
    return 'report_definition';
  }
  if (
    lowered.includes('policy') ||
    fileName.includes('规则') ||
    fileName.includes('策略') ||
    fileName.includes('权限')
  ) {
    return 'business_rule';
  }
  if (lowered.includes('memory')) {
    return 'memory';
  }
  return 'project_doc';
}

function inferModuleId(fileName: string) {
  const lowered = fileName.toLowerCase();
  const mappings: Array<[string, string]> = [
    ['order', 'orders'],
    ['订单', 'orders'],
    ['purchase', 'procurement'],
    ['采购', 'procurement'],
    ['inventory', 'inventory'],
    ['库存', 'inventory'],
    ['arrival', 'arrival'],
    ['到货', 'arrival'],
    ['inbound', 'inbound'],
    ['入库', 'inbound'],
    ['shipping', 'shipping'],
    ['发货', 'shipping'],
    ['finance', 'finance'],
    ['财务', 'finance'],
    ['report', 'reports'],
    ['报表', 'reports'],
    ['audit', 'settings'],
    ['security', 'settings'],
    ['权限', 'settings'],
    ['安全', 'settings'],
  ];

  for (const [keyword, moduleId] of mappings) {
    if (lowered.includes(keyword) || fileName.includes(keyword)) {
      return moduleId;
    }
  }

  return 'ai';
}

function toRegisteredSourceMeta(relativePath: string): RegisteredSourceMeta {
  return {
    docId: buildDocumentId(relativePath),
    docTitle: path.parse(relativePath).name,
    sourceType: inferSourceType(relativePath),
    moduleId: inferModuleId(relativePath),
    scopeType: 'global',
  };
}

function buildRegisteredSourceMap(
  documentPaths: string[],
  workspaceRoot: string,
  settings: KnowledgeDocumentSettings,
) {
  const result = new Map<string, RegisteredSourceMeta>();

  documentPaths.forEach((absolutePath) => {
    const relativePath = toRelativePath(workspaceRoot, absolutePath);
    const key = normalizeRelativePath(relativePath);
    if (!key || !resolveIncludeInAssistant(key, settings)) {
      return;
    }
    result.set(key, toRegisteredSourceMeta(key));
  });

  return result;
}

function defaultIncludeInAssistant(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith('docs/rag/knowledge/');
}

function readKnowledgeDocumentSettings(): KnowledgeDocumentSettings {
  const settingsPath = getKnowledgeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return {
      version: 1,
      updatedAt: '',
      includeInAssistant: {},
    };
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (!raw.trim()) {
      return {
        version: 1,
        updatedAt: '',
        includeInAssistant: {},
      };
    }
    const parsed = JSON.parse(raw) as Partial<KnowledgeDocumentSettings>;
    const includeInAssistant: Record<string, boolean> = {};
    if (parsed && parsed.includeInAssistant && typeof parsed.includeInAssistant === 'object') {
      Object.entries(parsed.includeInAssistant).forEach(([key, value]) => {
        includeInAssistant[normalizeRelativePath(key)] = Boolean(value);
      });
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      includeInAssistant,
    };
  } catch {
    return {
      version: 1,
      updatedAt: '',
      includeInAssistant: {},
    };
  }
}

function writeKnowledgeDocumentSettings(settings: KnowledgeDocumentSettings) {
  const settingsPath = getKnowledgeSettingsPath();
  const next: KnowledgeDocumentSettings = {
    version: 1,
    updatedAt: new Date().toISOString(),
    includeInAssistant: settings.includeInAssistant,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
}

function resolveIncludeInAssistant(relativePath: string, settings: KnowledgeDocumentSettings) {
  const key = normalizeRelativePath(relativePath);
  if (Object.prototype.hasOwnProperty.call(settings.includeInAssistant, key)) {
    return Boolean(settings.includeInAssistant[key]);
  }
  return defaultIncludeInAssistant(key);
}

function setDocumentInclusion(relativePath: string, includeInAssistant: boolean) {
  const settings = readKnowledgeDocumentSettings();
  settings.includeInAssistant[normalizeRelativePath(relativePath)] = includeInAssistant;
  writeKnowledgeDocumentSettings(settings);
}

function removeDocumentInclusion(relativePath: string) {
  const settings = readKnowledgeDocumentSettings();
  delete settings.includeInAssistant[normalizeRelativePath(relativePath)];
  writeKnowledgeDocumentSettings(settings);
}

function toDocumentSummary(
  resolved: ResolvedDocumentPath,
  stats: fs.Stats,
  registeredSourceMap: Map<string, RegisteredSourceMeta>,
  settings: KnowledgeDocumentSettings,
): LocalKnowledgeDocumentSummary {
  const relativePath = resolved.relativePath;
  const extension = path.extname(relativePath).toLowerCase();
  const registered = registeredSourceMap.get(relativePath);

  return {
    key: encodeDocumentKey(relativePath),
    relativePath,
    fileName: path.basename(relativePath),
    directory: path.dirname(relativePath) === '.' ? '/' : path.dirname(relativePath),
    extension,
    source: resolved.source,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
    isRegisteredSource: Boolean(registered),
    includeInAssistant: resolveIncludeInAssistant(relativePath, settings),
    docId: registered?.docId,
    docTitle: registered?.docTitle,
    sourceType: registered?.sourceType,
    moduleId: registered?.moduleId,
    scopeType: registered?.scopeType,
  };
}

export function listLocalKnowledgeDocuments() {
  const workspaceRoot = getWorkspaceRoot();
  const docsRoot = getDocsRoot(workspaceRoot);
  const documentPaths: string[] = [];

  collectDocsFiles(docsRoot, documentPaths);
  ROOT_KNOWLEDGE_FILES.forEach((fileName) => {
    const absolutePath = path.join(workspaceRoot, fileName);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() && hasAllowedExtension(fileName)) {
      documentPaths.push(absolutePath);
    }
  });

  const settings = readKnowledgeDocumentSettings();
  const registeredSourceMap = buildRegisteredSourceMap(documentPaths, workspaceRoot, settings);
  const summaries = documentPaths
    .map((absolutePath) => {
      const relativePath = toRelativePath(workspaceRoot, absolutePath);
      const resolved = resolveManagedDocumentPath(relativePath);
      const stats = fs.statSync(absolutePath);
      return toDocumentSummary(resolved, stats, registeredSourceMap, settings);
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));

  return summaries;
}

export function getLocalKnowledgeDocumentByKey(key: string): LocalKnowledgeDocumentDetail {
  const relativePath = decodeDocumentKey(key);
  const resolved = resolveManagedDocumentPath(relativePath);
  if (!fs.existsSync(resolved.absolutePath)) {
    throw new ApiError(404, `Document not found: ${resolved.relativePath}`, 'DOCUMENT_NOT_FOUND');
  }

  const stats = fs.statSync(resolved.absolutePath);
  if (!stats.isFile()) {
    throw new ApiError(400, `Document is not a file: ${resolved.relativePath}`, 'DOCUMENT_NOT_FILE');
  }

  const settings = readKnowledgeDocumentSettings();
  const registeredSourceMap = buildRegisteredSourceMap([resolved.absolutePath], resolved.workspaceRoot, settings);
  const content = fs.readFileSync(resolved.absolutePath, 'utf8');
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;

  return {
    document: toDocumentSummary(resolved, stats, registeredSourceMap, settings),
    content,
    lineCount,
  };
}

export function patchLocalKnowledgeDocumentByKey(key: string, input: PatchLocalKnowledgeDocumentInput) {
  const relativePath = decodeDocumentKey(key);
  const resolved = resolveManagedDocumentPath(relativePath);
  if (!fs.existsSync(resolved.absolutePath)) {
    throw new ApiError(404, `Document not found: ${resolved.relativePath}`, 'DOCUMENT_NOT_FOUND');
  }
  if (!fs.statSync(resolved.absolutePath).isFile()) {
    throw new ApiError(400, `Document is not a file: ${resolved.relativePath}`, 'DOCUMENT_NOT_FILE');
  }

  if (input.content === undefined && input.includeInAssistant === undefined) {
    throw new ApiError(400, 'No patch fields provided', 'DOCUMENT_PATCH_EMPTY');
  }

  if (input.content !== undefined) {
    fs.writeFileSync(resolved.absolutePath, input.content, 'utf8');
  }

  if (input.includeInAssistant !== undefined) {
    setDocumentInclusion(resolved.relativePath, input.includeInAssistant);
  }

  const content = fs.readFileSync(resolved.absolutePath, 'utf8');
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const stats = fs.statSync(resolved.absolutePath);
  const settings = readKnowledgeDocumentSettings();
  const registeredSourceMap = buildRegisteredSourceMap([resolved.absolutePath], resolved.workspaceRoot, settings);

  return {
    document: toDocumentSummary(resolved, stats, registeredSourceMap, settings),
    lineCount,
  };
}

function sanitizeUploadFileName(fileName: string) {
  const normalized = fileName.trim().replace(/\\/g, '/');
  const basename = path.basename(normalized);
  if (!basename || basename === '.' || basename === '..') {
    throw new ApiError(400, 'Invalid upload file name', 'INVALID_UPLOAD_FILE_NAME');
  }

  if (!hasAllowedExtension(basename)) {
    throw new ApiError(415, `Unsupported upload extension: ${path.extname(basename) || '(none)'}`, 'UNSUPPORTED_UPLOAD_EXTENSION');
  }

  return basename;
}

function resolveUploadTargetPath(fileName: string, targetDirInput?: string) {
  const workspaceRoot = getWorkspaceRoot();
  const docsRoot = getDocsRoot(workspaceRoot);
  const safeFileName = sanitizeUploadFileName(fileName);
  const targetDirRaw = (targetDirInput || DEFAULT_UPLOAD_DIR).trim();
  const targetDir = ensureSafeRelativePath(targetDirRaw);
  const absoluteDir = path.resolve(workspaceRoot, targetDir);

  if (!(absoluteDir === docsRoot || absoluteDir.startsWith(`${docsRoot}${path.sep}`))) {
    throw new ApiError(400, 'Upload target must be inside docs directory', 'UPLOAD_TARGET_FORBIDDEN');
  }

  const absolutePath = path.join(absoluteDir, safeFileName);
  const relativePath = toRelativePath(workspaceRoot, absolutePath);
  return resolveManagedDocumentPath(relativePath);
}

export function uploadLocalKnowledgeDocument(input: {
  fileName: string;
  content: string;
  targetDir?: string;
  overwrite?: boolean;
  includeInAssistant?: boolean;
}) {
  const resolved = resolveUploadTargetPath(input.fileName, input.targetDir);
  if (fs.existsSync(resolved.absolutePath) && !input.overwrite) {
    throw new ApiError(409, `Document already exists: ${resolved.relativePath}`, 'DOCUMENT_ALREADY_EXISTS');
  }

  fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
  fs.writeFileSync(resolved.absolutePath, input.content, 'utf8');

  if (input.includeInAssistant !== undefined) {
    setDocumentInclusion(resolved.relativePath, input.includeInAssistant);
  }

  const stats = fs.statSync(resolved.absolutePath);
  const settings = readKnowledgeDocumentSettings();
  const registeredSourceMap = buildRegisteredSourceMap([resolved.absolutePath], resolved.workspaceRoot, settings);

  return {
    document: toDocumentSummary(resolved, stats, registeredSourceMap, settings),
    lineCount: input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length,
  };
}

export function deleteLocalKnowledgeDocumentByKey(key: string) {
  const relativePath = decodeDocumentKey(key);
  const resolved = resolveManagedDocumentPath(relativePath);
  if (!fs.existsSync(resolved.absolutePath)) {
    throw new ApiError(404, `Document not found: ${resolved.relativePath}`, 'DOCUMENT_NOT_FOUND');
  }
  if (!fs.statSync(resolved.absolutePath).isFile()) {
    throw new ApiError(400, `Document is not a file: ${resolved.relativePath}`, 'DOCUMENT_NOT_FILE');
  }

  fs.unlinkSync(resolved.absolutePath);
  removeDocumentInclusion(resolved.relativePath);
  return {
    deleted: true,
    relativePath: resolved.relativePath,
  };
}

