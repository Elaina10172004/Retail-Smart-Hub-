import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { resolveWorkspaceRoot } from './workspace-root';
import {
  normalizeText,
  splitIntoParagraphs,
  splitLongParagraph,
  splitMarkdownSections,
  splitPlainTextSections,
  type SectionBlock,
} from './rag-section-splitter';

type SourceType = 'project_doc' | 'business_rule' | 'report_definition' | 'api_spec' | 'db_spec' | 'memory';
type ScopeType = 'global' | 'module' | 'tenant' | 'user' | 'session';
type RetrievalMode = 'dense' | 'lexical' | 'hybrid';
type RetrievalScope = 'global' | 'module' | 'tenant' | 'user' | 'session' | 'all';
type MemoryTier = 'working' | 'episodic' | 'semantic' | 'archive';

interface KnowledgeSourceDefinition {
  docId: string;
  fileName: string;
  docTitle: string;
  sourceType: SourceType;
  moduleId: string;
  scopeType: ScopeType;
}

interface KnowledgeChunk {
  id: string;
  docId: string;
  docTitle: string;
  sectionTitle: string;
  sourceType: SourceType;
  moduleId: string;
  scopeType: ScopeType;
  scopeId?: string;
  updatedAt: string;
  updatedAtTs: number;
  version: string;
  keywords: string[];
  content: string;
  citation: string;
  memoryTier?: MemoryTier;
  memoryImportance?: number;
  memoryReinforcedCount?: number;
  memoryDecayScore?: number;
}

interface IndexedKnowledgeChunk extends KnowledgeChunk {
  termFreq: Map<string, number>;
  tokenSet: Set<string>;
  bodyLength: number;
  tfidfNorm: number;
  vector?: number[];
}

interface KnowledgeIndexCache {
  signature: string;
  chunks: IndexedKnowledgeChunk[];
  chunkMap: Map<string, IndexedKnowledgeChunk>;
  idfMap: Map<string, number>;
  averageBodyLength: number;
  refreshedAt: string;
}

interface LanceChunkRow {
  id: string;
  docId: string;
  docTitle: string;
  sectionTitle: string;
  sourceType: SourceType;
  moduleId: string;
  scope: ScopeType;
  scopeId?: string;
  updatedAt: string;
  updatedAtTs: number;
  version: string;
  keywords: string[];
  content: string;
  citation: string;
  metadata: string;
  ts: number;
  vector: number[];
}

interface LanceResultScore {
  id: string;
  score: number;
  vector?: number[];
}

interface SourceBuildResult {
  chunks: IndexedKnowledgeChunk[];
  sourceSignatures: Record<string, string>;
}

interface RagManifest {
  version: number;
  updatedAt: string;
  sourceSignatures: Record<string, string>;
  chunkCount: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
}

interface RetrievalMergedOptions {
  limit: number;
  candidateLimit: number;
  minScore: number;
  retrievalMode: RetrievalMode;
  scope: RetrievalScope;
  moduleIds: string[];
  sourceTypes: SourceType[];
  docIds: string[];
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  fromTs?: number;
  toTs?: number;
}

interface RetrievalCandidate {
  indexed: IndexedKnowledgeChunk;
  hybridScore: number;
  rerankScore: number;
  lexicalScore: number;
  denseScore: number;
  recencyScore: number;
}

interface RetrievalDebugBundle {
  final: RetrievedKnowledgeChunk[];
  baseline: RetrievedKnowledgeChunk[];
}

interface LanceState {
  enabled: boolean;
  available: boolean;
  tableName: string;
  dbPath: string;
  indexedRows: number;
  changedDocIds: string[];
  removedDocIds: string[];
  lastSyncAt: string;
  lastError: string;
}

interface LanceDbContext {
  db: any;
  table: any;
  module: any;
}

interface LanceDbSyncResult {
  enabled: boolean;
  available: boolean;
  indexedRows: number;
  changedDocIds: string[];
  removedDocIds: string[];
  lastError: string;
}

interface RetrievalScoreMaps {
  dense: Map<string, number>;
  lexical: Map<string, number>;
  denseVectors: Map<string, number[]>;
}

interface EvalCase {
  id?: string;
  query: string;
  moduleIds?: string[];
  sourceTypes?: SourceType[];
  docIds?: string[];
  expectedDocIds?: string[];
  expectedCitations?: string[];
  expectedKeywords?: string[];
}

interface MemoryRecord {
  id: string;
  userId: string;
  tenantId?: string;
  sessionId?: string;
  title: string;
  content: string;
  createdAt: string;
  tier: MemoryTier;
  importance: number;
  reinforcedCount: number;
  lastAccessAt: string;
  lastReinforcedAt?: string;
  tags: string[];
}

export interface KnowledgeQueryOptions {
  limit?: number;
  candidateLimit?: number;
  minScore?: number;
  retrievalMode?: RetrievalMode;
  scope?: RetrievalScope;
  moduleIds?: string[];
  sourceTypes?: SourceType[];
  docIds?: string[];
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  forceRetrieve?: boolean;
  fromTs?: number;
  toTs?: number;
}

export interface RetrievedKnowledgeChunk extends KnowledgeChunk {
  score: number;
  denseScore: number;
  lexicalScore: number;
  recencyScore: number;
  rerankScore: number;
}

export interface KnowledgeQueryInferredOptions {
  moduleIds: string[];
  sourceTypes: SourceType[];
  docIds: string[];
}

export interface KnowledgeStats {
  sourceCount: number;
  chunkCount: number;
  sources: string[];
  retrievalMode: RetrievalMode;
  scope: RetrievalScope;
  lancedb: LanceState;
  rerankProvider: string;
  adaptiveRetrieval: boolean;
}

export interface KnowledgeSourceDiagnostic {
  docId: string;
  fileName: string;
  absolutePath: string;
  sourceType: SourceType;
  moduleId: string;
  scopeType: ScopeType;
  exists: boolean;
  size: number;
  updatedAt: string;
  currentSignature: string;
  manifestSignature: string;
  inManifest: boolean;
  signatureChanged: boolean;
}

export interface KnowledgeDiagnostics {
  generatedAt: string;
  manifestPath: string;
  manifestExists: boolean;
  manifest: RagManifest | null;
  cacheSignature: string;
  cacheRefreshedAt: string;
  sourceCount: number;
  sourcePresentCount: number;
  missingSources: string[];
  changedSinceManifest: string[];
  sources: KnowledgeSourceDiagnostic[];
  memory: {
    total: number;
    byTier: Record<MemoryTier, number>;
    perUserTop: Array<{ userId: string; count: number }>;
    maxPerUser: number;
    maxGlobal: number;
  };
  lancedb: LanceState;
}

export interface RebuildKnowledgeIndexOptions {
  force?: boolean;
  incremental?: boolean;
}

export interface RebuildKnowledgeIndexResult {
  chunkCount: number;
  sourceCount: number;
  changedDocIds: string[];
  removedDocIds: string[];
  lancedbEnabled: boolean;
  lancedbAvailable: boolean;
  lancedbIndexedRows: number;
  lancedbError: string;
  signature: string;
  refreshedAt: string;
}

export interface EvaluateKnowledgeOptions {
  datasetPath: string;
  k?: number;
}

export interface EvaluateKnowledgeResult {
  total: number;
  k: number;
  hitRateBaseline: number;
  hitRateReranked: number;
  mrrBaseline: number;
  mrrReranked: number;
  rerankGain: number;
  failedCases: Array<{
    id: string;
    query: string;
    expected: string;
    baselineTop: string[];
    rerankedTop: string[];
  }>;
}

export interface CaptureMemoryInput {
  userId: string;
  tenantId?: string;
  sessionId?: string;
  prompt: string;
  reply: string;
  citations?: string[];
}

export interface ConversationMemoryFact {
  id: string;
  userId: string;
  tenantId?: string;
  sessionId?: string;
  title: string;
  content: string;
  createdAt: string;
  tier: MemoryTier;
  importance: number;
  reinforcedCount: number;
  lastAccessAt: string;
  lastReinforcedAt?: string;
  tags: string[];
}

const SOURCE_DEFINITIONS: KnowledgeSourceDefinition[] = [
  {
    docId: 'business-rules',
    fileName: 'docs/rag/knowledge/业务规则与接口说明.md',
    docTitle: 'Business Rules',
    sourceType: 'business_rule',
    moduleId: 'ai',
    scopeType: 'global',
  },
  {
    docId: 'document-rules',
    fileName: 'docs/rag/knowledge/单据状态流转与操作规则.md',
    docTitle: 'Document Rules',
    sourceType: 'business_rule',
    moduleId: 'ai',
    scopeType: 'global',
  },
  {
    docId: 'report-definitions',
    fileName: 'docs/rag/knowledge/报表口径与指标说明.md',
    docTitle: 'Report Definitions',
    sourceType: 'report_definition',
    moduleId: 'reports',
    scopeType: 'module',
  },
  {
    docId: 'api-catalog',
    fileName: 'docs/rag/knowledge/接口清单与权限映射.md',
    docTitle: 'API Catalog',
    sourceType: 'api_spec',
    moduleId: 'ai',
    scopeType: 'global',
  },
  {
    docId: 'role-security-guide',
    fileName: 'docs/rag/knowledge/角色模板与安全分级说明.md',
    docTitle: 'Role And Security Guide',
    sourceType: 'business_rule',
    moduleId: 'settings',
    scopeType: 'module',
  },
  {
    docId: 'audit-definitions',
    fileName: 'docs/rag/knowledge/审计日志与口径说明.md',
    docTitle: 'Audit Definitions',
    sourceType: 'business_rule',
    moduleId: 'settings',
    scopeType: 'module',
  },
  {
    docId: 'security-rules',
    fileName: 'docs/rag/knowledge/系统安全与权限策略说明.md',
    docTitle: 'Security Rules',
    sourceType: 'business_rule',
    moduleId: 'ai',
    scopeType: 'global',
  },
  {
    docId: 'db-structure',
    fileName: 'docs/rag/knowledge/数据库结构与核心表说明.md',
    docTitle: 'Database Structure',
    sourceType: 'db_spec',
    moduleId: 'ai',
    scopeType: 'global',
  },
  {
    docId: 'import-guide',
    fileName: 'docs/rag/knowledge/批量导入与AI直录入说明.md',
    docTitle: 'Import And AI Entry Guide',
    sourceType: 'business_rule',
    moduleId: 'settings',
    scopeType: 'module',
  },
  {
    docId: 'economics-knowledge',
    fileName: 'docs/rag/knowledge/经济学与经营分析知识库.md',
    docTitle: 'Economics And Business Analysis Knowledge',
    sourceType: 'project_doc',
    moduleId: 'ai',
    scopeType: 'global',
  },
];

const MODULE_KEYWORDS: Array<{ moduleId: string; keywords: string[] }> = [
  { moduleId: 'orders', keywords: ['order', 'sales order', 'ord-'] },
  { moduleId: 'inventory', keywords: ['inventory', 'stock', 'sku', 'item'] },
  { moduleId: 'procurement', keywords: ['procurement', 'purchase', 'supplier', 'po'] },
  { moduleId: 'arrival', keywords: ['arrival', 'receiving'] },
  { moduleId: 'inbound', keywords: ['inbound', 'putaway'] },
  { moduleId: 'shipping', keywords: ['shipping', 'logistics', 'waybill', 'outbound'] },
  { moduleId: 'finance', keywords: ['finance', 'receivable', 'payable', 'payment'] },
  { moduleId: 'reports', keywords: ['report', 'analytics', 'sales', 'gross margin'] },
  { moduleId: 'settings', keywords: ['permission', 'role', 'user', 'audit', 'settings'] },
  { moduleId: 'ai', keywords: ['rag', 'function', 'model', 'ai', 'deepseek', 'embedding', 'skill'] },
];

const SOURCE_TYPE_KEYWORDS: Array<{ sourceType: SourceType; keywords: string[] }> = [
  { sourceType: 'business_rule', keywords: ['rule', 'workflow', 'permission', 'function use', 'rag'] },
  { sourceType: 'project_doc', keywords: ['phase', 'project', 'structure', 'overview', 'status'] },
  { sourceType: 'report_definition', keywords: ['report metric', 'indicator', 'stats'] },
  { sourceType: 'api_spec', keywords: ['api', 'endpoint', 'interface'] },
  { sourceType: 'db_spec', keywords: ['database', 'schema', 'column'] },
];

const SOURCE_TYPE_MEMORY_KEYWORDS = ['memory', 'previous conversation', 'conversation memory'];
SOURCE_TYPE_KEYWORDS.push({ sourceType: 'memory', keywords: SOURCE_TYPE_MEMORY_KEYWORDS });

const DOC_KEYWORDS: Array<{ docId: string; keywords: string[] }> = [
  { docId: 'business-rules', keywords: ['business rules', 'api description', 'permission scope'] },
  { docId: 'document-rules', keywords: ['document status', 'operation rules', 'message center'] },
  { docId: 'report-definitions', keywords: ['report metric', 'indicator definition', 'aging analysis', 'gross margin'] },
  { docId: 'api-catalog', keywords: ['api catalog', 'permission map', 'api'] },
  { docId: 'role-security-guide', keywords: ['role template', 'authorization template', 'security level'] },
  { docId: 'audit-definitions', keywords: ['audit metric', 'audit logs', 'traceability'] },
  { docId: 'security-rules', keywords: ['security policy', 'password policy', 'failed login', 'session policy'] },
  { docId: 'db-structure', keywords: ['database schema', 'core table', 'column definition'] },
  { docId: 'import-guide', keywords: ['import', 'txt', 'xls', 'xlsx', 'directory import'] },
  {
    docId: 'economics-knowledge',
    keywords: ['economics', 'macro', 'micro', 'elasticity', 'demand', 'supply', 'pricing', 'inventory economics', '经济学', '宏观', '微观', '弹性', '需求', '供给', '调价', '库存经济学', '边际成本', '贡献毛利', '现金转换周期', '牛鞭效应'],
  },
];

const CHUNK_MIN_LENGTH = 240;
const CHUNK_MAX_LENGTH = 900;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'your',
  'about',
  'there',
  'which',
  'what',
  'when',
  'where',
  'into',
  'then',
  'than',
]);

const defaultCache: KnowledgeIndexCache = {
  signature: '',
  chunks: [],
  chunkMap: new Map(),
  idfMap: new Map(),
  averageBodyLength: 1,
  refreshedAt: '',
};

const defaultLanceState: LanceState = {
  enabled: false,
  available: false,
  tableName: env.ragLancedbTable || 'knowledge_chunks',
  dbPath: env.ragLancedbDir || path.resolve(process.cwd(), 'database', 'rag', 'lancedb'),
  indexedRows: 0,
  changedDocIds: [],
  removedDocIds: [],
  lastSyncAt: '',
  lastError: '',
};

let cache: KnowledgeIndexCache = defaultCache;
let lanceState: LanceState = defaultLanceState;
let refreshPromise: Promise<KnowledgeIndexCache> | null = null;
let lanceContextPromise: Promise<LanceDbContext | null> | null = null;
const queryEmbeddingCache = new Map<string, number[]>();

const MEMORY_TIER_WEIGHT: Record<MemoryTier, number> = {
  working: 0.92,
  episodic: 1.08,
  semantic: 1.22,
  archive: 0.75,
};

function parseRetrievalMode(value: string | undefined): RetrievalMode {
  if (value === 'dense' || value === 'lexical' || value === 'hybrid') {
    return value;
  }
  return 'hybrid';
}

function parseScope(value: string | undefined): RetrievalScope {
  if (
    value === 'global' ||
    value === 'module' ||
    value === 'tenant' ||
    value === 'user' ||
    value === 'session' ||
    value === 'all'
  ) {
    return value;
  }
  return 'all';
}

function toPositiveNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getWorkspaceRoot() {
  return resolveWorkspaceRoot();
}

function getRagDataRoot() {
  const root = path.resolve(process.cwd(), 'database', 'rag');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function getManifestPath() {
  return path.join(getRagDataRoot(), 'index-manifest.json');
}

function getMemoryStorePath() {
  return path.join(getRagDataRoot(), 'memory-store.jsonl');
}

function safeParseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toSafeIso(value: unknown, fallbackIso: string) {
  if (typeof value !== 'string') {
    return fallbackIso;
  }
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    return fallbackIso;
  }
  return new Date(ts).toISOString();
}

function toUnitNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return clamp(fallback, 0, 1);
  }
  return clamp(parsed, 0, 1);
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Math.floor(fallback));
  }
  return Math.max(1, Math.floor(parsed));
}

function normalizeMemoryTier(value: unknown): MemoryTier {
  if (value === 'working' || value === 'episodic' || value === 'semantic' || value === 'archive') {
    return value;
  }
  return 'working';
}

function getMemoryRetentionDays(tier: MemoryTier) {
  const globalRetention = Math.max(1, toPositiveNumber(env.ragMemoryRetentionDays, 60));
  const working = Math.max(1, Math.min(globalRetention, toPositiveNumber(env.ragMemoryWorkingDays, 14)));
  const episodic = Math.max(working, toPositiveNumber(env.ragMemoryEpisodicDays, 90));
  const semantic = Math.max(episodic, toPositiveNumber(env.ragMemorySemanticDays, 365));
  if (tier === 'working') {
    return working;
  }
  if (tier === 'episodic') {
    return episodic;
  }
  if (tier === 'semantic') {
    return semantic;
  }
  return Math.max(semantic, globalRetention * 2);
}

function inferMemoryTags(prompt: string, reply: string) {
  const text = `${prompt}\n${reply}`.toLowerCase();
  const tags = new Set<string>();

  for (const candidate of MODULE_KEYWORDS) {
    if (candidate.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      tags.add(candidate.moduleId);
    }
  }

  if (/(create|add|new|register|import)/i.test(prompt)) {
    tags.add('write');
  }
  if (/(query|view|stats|analysis|detail|report)/i.test(prompt)) {
    tags.add('read');
  }
  if (/(confirm|undo|cancel|execute)/i.test(prompt)) {
    tags.add('action');
  }
  if (/(rule|metric|permission|policy|workflow)/i.test(prompt)) {
    tags.add('policy');
  }

  return Array.from(tags).slice(0, 10);
}

function estimateMemoryImportance(input: CaptureMemoryInput) {
  const prompt = input.prompt.trim();
  const reply = input.reply.trim();
  let score = 0.42;
  score += Math.min(0.18, prompt.length / 520);
  score += Math.min(0.12, reply.length / 1800);

  if (input.citations && input.citations.length > 0) {
    score += 0.1;
  }
  if (/[A-Z]{2,8}-\d{2,}/.test(prompt) || /SKU-\d+|CUS-\d+|PO-\d+|SO-\d+|AR-\d+|AP-\d+/.test(prompt)) {
    score += 0.12;
  }
  if (/(create|import|confirm|undo|cancel|execute|payment|shipping|inbound|restock)/i.test(prompt)) {
    score += 0.12;
  }
  if (/(rule|metric|permission|policy|workflow|audit)/i.test(prompt)) {
    score += 0.08;
  }
  if (/(executed|completed|confirmed|created|registered)/i.test(reply)) {
    score += 0.06;
  }

  return clamp(score, 0.25, 0.98);
}

function chooseMemoryTier(reinforcedCount: number, importance: number): MemoryTier {
  const semanticReinforce = Math.max(1, toPositiveNumber(env.ragMemorySemanticReinforce, 5));
  const semanticImportance = clamp(toPositiveNumber(env.ragMemorySemanticImportance, 0.82), 0.1, 1);
  if (reinforcedCount >= semanticReinforce || importance >= semanticImportance) {
    return 'semantic';
  }

  const promotionReinforce = Math.max(1, toPositiveNumber(env.ragMemoryPromotionReinforce, 2));
  const promotionImportance = clamp(toPositiveNumber(env.ragMemoryPromotionImportance, 0.62), 0.1, 1);
  if (reinforcedCount >= promotionReinforce || importance >= promotionImportance) {
    return 'episodic';
  }

  return 'working';
}

function memoryDecayAt(record: MemoryRecord, nowTs: number) {
  const anchorIso = record.lastReinforcedAt || record.lastAccessAt || record.createdAt;
  const anchorTs = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchorTs)) {
    return 1;
  }
  const halfLifeDays = Math.max(14, toPositiveNumber(env.ragMemoryDecayHalfLifeDays, 120));
  const ageDays = Math.max(0, (nowTs - anchorTs) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / halfLifeDays);
}

function memorySimilarity(left: string, right: string) {
  if (left === right) {
    return 1;
  }
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function evaluateMemoryLifecycle(record: MemoryRecord, nowTs: number) {
  const createdTs = new Date(record.createdAt).getTime();
  if (!Number.isFinite(createdTs)) {
    return { keep: false, nextTier: record.tier };
  }

  const decay = memoryDecayAt(record, nowTs);
  const effectiveImportance = clamp(record.importance * (0.35 + 0.65 * decay), 0, 1);
  const suggestedTier = chooseMemoryTier(record.reinforcedCount, effectiveImportance);
  const nextTier = record.tier === 'archive' && effectiveImportance < 0.4 ? 'archive' : suggestedTier;

  const ageDays = Math.max(0, (nowTs - createdTs) / (1000 * 60 * 60 * 24));
  const retentionDays = getMemoryRetentionDays(record.tier);
  const semanticGraceDays = record.tier === 'semantic' ? retentionDays * 0.5 : 0;
  const keepAge = ageDays <= retentionDays + semanticGraceDays;
  if (keepAge) {
    return { keep: true, nextTier };
  }

  if (effectiveImportance >= 0.78 || record.reinforcedCount >= Math.max(3, toPositiveNumber(env.ragMemoryPromotionReinforce, 2) + 1)) {
    return { keep: true, nextTier: 'archive' as MemoryTier };
  }

  return { keep: false, nextTier };
}

function memoryRankingScore(record: MemoryRecord, nowTs: number) {
  const tierWeight = MEMORY_TIER_WEIGHT[record.tier] ?? 0.9;
  const decay = memoryDecayAt(record, nowTs);
  const reinforceBoost = Math.min(0.5, Math.log2(record.reinforcedCount + 1) * 0.2);
  return tierWeight * 0.42 + record.importance * 0.34 + reinforceBoost * 0.14 + decay * 0.1;
}

function writeMemoryRecords(records: MemoryRecord[]) {
  const filePath = getMemoryStorePath();
  if (records.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    return;
  }

  const sorted = [...records].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const lines = sorted.map((record) => JSON.stringify(record));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function compactMemoryRecords(records: MemoryRecord[]) {
  const maxPerUser = Math.max(50, toPositiveNumber(env.ragMemoryMaxPerUser, 600));
  const maxGlobal = Math.max(maxPerUser, toPositiveNumber(env.ragMemoryMaxGlobal, 12000));
  const nowTs = Date.now();
  const sorted = [...records].sort((left, right) => {
    const scoreDiff = memoryRankingScore(right, nowTs) - memoryRankingScore(left, nowTs);
    if (Math.abs(scoreDiff) > 1e-8) {
      return scoreDiff;
    }
    return right.createdAt.localeCompare(left.createdAt);
  });

  const perUserCounter = new Map<string, number>();
  const kept: MemoryRecord[] = [];
  for (const record of sorted) {
    if (kept.length >= maxGlobal) {
      break;
    }
    const used = perUserCounter.get(record.userId) ?? 0;
    if (used >= maxPerUser) {
      continue;
    }
    kept.push(record);
    perUserCounter.set(record.userId, used + 1);
  }

  const changed = kept.length !== records.length;
  return { records: kept, changed };
}

function readMemoryRecords(): MemoryRecord[] {
  const filePath = getMemoryStorePath();
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const nowIso = new Date().toISOString();
  const nowTs = Date.now();
  const items: MemoryRecord[] = [];
  let dirty = false;

  for (const line of lines) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) {
      dirty = true;
      continue;
    }

    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const userId = typeof parsed.userId === 'string' ? parsed.userId : '';
    const tenantId = typeof parsed.tenantId === 'string' && parsed.tenantId.trim() ? parsed.tenantId : undefined;
    const title = typeof parsed.title === 'string' ? parsed.title : 'Memory';
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const createdAt = toSafeIso(parsed.createdAt, nowIso);
    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId : undefined;
    const tier = normalizeMemoryTier(parsed.tier);
    const importance = toUnitNumber(parsed.importance, 0.5);
    const reinforcedCount = toPositiveInt(parsed.reinforcedCount, 1);
    const lastAccessAt = toSafeIso(parsed.lastAccessAt, createdAt);
    const lastReinforcedAt =
      typeof parsed.lastReinforcedAt === 'string' && parsed.lastReinforcedAt.trim()
        ? toSafeIso(parsed.lastReinforcedAt, createdAt)
        : undefined;
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string').slice(0, 10) : [];
    const createdTs = new Date(createdAt).getTime();
    if (!id || !userId || !content || !Number.isFinite(createdTs)) {
      dirty = true;
      continue;
    }

    const record: MemoryRecord = {
      id,
      userId,
      tenantId,
      sessionId,
      title,
      content,
      createdAt,
      tier,
      importance,
      reinforcedCount,
      lastAccessAt,
      lastReinforcedAt,
      tags,
    };

    const lifecycle = evaluateMemoryLifecycle(record, nowTs);
    if (!lifecycle.keep) {
      dirty = true;
      continue;
    }

    if (record.tier !== lifecycle.nextTier) {
      record.tier = lifecycle.nextTier;
      dirty = true;
    }

    items.push(record);
  }

  const compacted = compactMemoryRecords(items);
  if (compacted.changed) {
    dirty = true;
  }

  if (dirty) {
    writeMemoryRecords(compacted.records);
  }
  return compacted.records;
}

const MEMORY_NOISE_PATTERNS = [/^(hi|hello|hey)\b/i, /^(你好|您好|在吗|在不在|谢谢|多谢|收到|好的|ok|嗯嗯|哈哈)\s*$/i];

function shouldSkipMemoryCapture(prompt: string, reply: string) {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length < 6) {
    return true;
  }
  if (MEMORY_NOISE_PATTERNS.some((pattern) => pattern.test(normalizedPrompt))) {
    return true;
  }
  if (!reply.trim()) {
    return true;
  }
  if (/^(请求失败|接口异常|模型请求失败|网络错误)/.test(reply.trim())) {
    return true;
  }
  return false;
}

function memoryTitleFromPrompt(prompt: string) {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 36 ? trimmed : `${trimmed.slice(0, 36)}...`;
}

function buildMemoryContent(input: CaptureMemoryInput) {
  const citationText = input.citations && input.citations.length > 0 ? `\n引用: ${input.citations.slice(0, 3).join(' | ')}` : '';
  const promptText = input.prompt.trim();
  const replyText = input.reply.trim();
  return `用户问题: ${promptText}\n助手回答: ${replyText}${citationText}`;
}

function findReinforceTarget(
  records: MemoryRecord[],
  userId: string,
  content: string,
  prompt: string,
  tenantId?: string,
) {
  const latest = records
    .filter((item) => item.userId === userId && (!tenantId || item.tenantId === tenantId))
    .sort((left, right) => right.lastAccessAt.localeCompare(left.lastAccessAt))
    .slice(0, 40);

  const exact = latest.find((item) => item.content === content);
  if (exact) {
    return exact;
  }

  const promptTitle = memoryTitleFromPrompt(prompt);
  let best: { item: MemoryRecord; score: number } | null = null;
  for (const item of latest) {
    const similarity = memorySimilarity(item.content, content);
    if (similarity >= 0.88) {
      if (!best || similarity > best.score) {
        best = { item, score: similarity };
      }
      continue;
    }

    if (item.title === promptTitle && similarity >= 0.72) {
      const composite = similarity + 0.08;
      if (!best || composite > best.score) {
        best = { item, score: composite };
      }
    }
  }

  return best?.item;
}

const memoryTouchCache = new Map<string, number>();
const MEMORY_TOUCH_COOLDOWN_MS = 5 * 60 * 1000;

function touchMemoryRecords(ids: string[]) {
  if (ids.length === 0) {
    return;
  }

  const nowTs = Date.now();
  const toTouch = Array.from(new Set(ids)).filter((id) => {
    const last = memoryTouchCache.get(id) ?? 0;
    return nowTs - last >= MEMORY_TOUCH_COOLDOWN_MS;
  });
  if (toTouch.length === 0) {
    return;
  }

  const records = readMemoryRecords();
  let changed = false;
  const nowIso = new Date(nowTs).toISOString();
  const nowUpdatedTs = new Date(nowIso).getTime();
  const touchSet = new Set(toTouch);
  for (const record of records) {
    if (!touchSet.has(record.id)) {
      continue;
    }
    record.lastAccessAt = nowIso;
    memoryTouchCache.set(record.id, nowTs);
    changed = true;
  }

  if (changed) {
    writeMemoryRecords(records);
    for (const record of records) {
      if (!touchSet.has(record.id)) {
        continue;
      }
      const chunk = cache.chunkMap.get(record.id);
      if (!chunk || chunk.sourceType !== 'memory') {
        continue;
      }
      chunk.updatedAt = nowIso;
      chunk.updatedAtTs = nowUpdatedTs;
      chunk.version = nowIso;
      chunk.memoryDecayScore = memoryDecayAt(record, nowTs);
    }
  }
}

export function captureConversationMemory(input: CaptureMemoryInput) {
  if (!env.ragMemoryEnabled) {
    return { captured: false, reason: 'memory disabled' as const };
  }
  if (shouldSkipMemoryCapture(input.prompt, input.reply)) {
    return { captured: false, reason: 'noise prompt' as const };
  }

  const records = readMemoryRecords();
  const content = buildMemoryContent(input);
  const nowIso = new Date().toISOString();
  const nextImportance = estimateMemoryImportance(input);
  const nextTags = inferMemoryTags(input.prompt, input.reply);
  const reinforceTarget = findReinforceTarget(records, input.userId, content, input.prompt, input.tenantId);
  if (reinforceTarget) {
    reinforceTarget.reinforcedCount += 1;
    reinforceTarget.importance = clamp(Math.max(reinforceTarget.importance, nextImportance) + 0.05, 0, 1);
    reinforceTarget.lastReinforcedAt = nowIso;
    reinforceTarget.lastAccessAt = nowIso;
    reinforceTarget.tier = chooseMemoryTier(reinforceTarget.reinforcedCount, reinforceTarget.importance);
    reinforceTarget.tags = Array.from(new Set([...reinforceTarget.tags, ...nextTags])).slice(0, 10);

    writeMemoryRecords(records);
    cache = defaultCache;
    return { captured: true, id: reinforceTarget.id, mode: 'reinforced' as const };
  }

  const record: MemoryRecord = {
    id: `mem-${nowIso.replace(/[-:.TZ]/g, '')}-${Math.random().toString(36).slice(2, 8)}`,
    userId: input.userId,
    tenantId: input.tenantId?.trim() || undefined,
    sessionId: input.sessionId?.trim() || undefined,
    title: memoryTitleFromPrompt(input.prompt),
    content,
    createdAt: nowIso,
    tier: chooseMemoryTier(1, nextImportance),
    importance: nextImportance,
    reinforcedCount: 1,
    lastAccessAt: nowIso,
    lastReinforcedAt: nowIso,
    tags: nextTags,
  };

  records.push(record);
  const compacted = compactMemoryRecords(records).records;
  writeMemoryRecords(compacted);
  cache = defaultCache;
  return { captured: true, id: record.id, mode: 'created' as const };
}

export function listConversationMemoryFacts(input: {
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  limit?: number;
} = {}): ConversationMemoryFact[] {
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const records = readMemoryRecords()
    .filter((item) => {
      if (input.userId && item.userId !== input.userId) {
        return false;
      }
      if (input.tenantId && item.tenantId !== input.tenantId) {
        return false;
      }
      if (input.sessionId && item.sessionId !== input.sessionId) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.lastAccessAt.localeCompare(left.lastAccessAt))
    .slice(0, limit);

  return records.map((item) => ({
    id: item.id,
    userId: item.userId,
    tenantId: item.tenantId,
    sessionId: item.sessionId,
    title: item.title,
    content: item.content,
    createdAt: item.createdAt,
    tier: item.tier,
    importance: item.importance,
    reinforcedCount: item.reinforcedCount,
    lastAccessAt: item.lastAccessAt,
    lastReinforcedAt: item.lastReinforcedAt,
    tags: item.tags,
  }));
}

export function deleteConversationMemoryFact(input: {
  id: string;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
}) {
  const targetId = input.id.trim();
  if (!targetId) {
    return { deleted: false, reason: 'invalid_id' as const };
  }

  const records = readMemoryRecords();
  const index = records.findIndex((item) => item.id === targetId);
  if (index < 0) {
    return { deleted: false, reason: 'not_found' as const };
  }

  const record = records[index];
  if (input.userId && record.userId !== input.userId) {
    return { deleted: false, reason: 'user_mismatch' as const };
  }
  if (input.tenantId && record.tenantId !== input.tenantId) {
    return { deleted: false, reason: 'tenant_mismatch' as const };
  }
  if (input.sessionId && record.sessionId !== input.sessionId) {
    return { deleted: false, reason: 'session_mismatch' as const };
  }

  records.splice(index, 1);
  writeMemoryRecords(records);
  cache = defaultCache;
  return {
    deleted: true,
    id: targetId,
    removed: {
      title: record.title,
      tier: record.tier,
      createdAt: record.createdAt,
    },
  };
}


function sanitizeId(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'section'
  );
}

function tokenize(text: string) {
  const normalized = text.toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const chineseSegments = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const chineseTokens: string[] = [];

  for (const segment of chineseSegments) {
    if (segment.length <= 4) {
      chineseTokens.push(segment);
      continue;
    }
    for (let length = 2; length <= 4; length += 1) {
      for (let index = 0; index + length <= segment.length; index += 1) {
        chineseTokens.push(segment.slice(index, index + length));
      }
    }
  }

  return [...asciiTokens, ...chineseTokens].filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function termFrequency(tokens: string[]) {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

function inferModuleId(text: string) {
  const normalized = text.toLowerCase();
  let bestModule = 'ai';
  let bestScore = 0;

  for (const candidate of MODULE_KEYWORDS) {
    const score = candidate.keywords.reduce((sum, keyword) => {
      return sum + (normalized.includes(keyword.toLowerCase()) ? keyword.length : 0);
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      bestModule = candidate.moduleId;
    }
  }

  return bestModule;
}

function extractKeywords(text: string) {
  return Array.from(new Set(tokenize(text)));
}

function buildChunksFromSection(
  source: KnowledgeSourceDefinition,
  sectionTitle: string,
  content: string,
  updatedAt: string,
): IndexedKnowledgeChunk[] {
  const paragraphs = splitIntoParagraphs(content).flatMap((paragraph) =>
    splitLongParagraph(paragraph, CHUNK_MIN_LENGTH, CHUNK_MAX_LENGTH),
  );
  const chunks: IndexedKnowledgeChunk[] = [];
  let buffer = '';
  let counter = 1;

  const pushChunk = () => {
    const chunkContent = buffer.trim();
    if (!chunkContent) {
      buffer = '';
      return;
    }

    const inferredModule = source.moduleId === 'ai' ? inferModuleId(`${sectionTitle}\n${chunkContent}`) : source.moduleId;
    const baseChunk: KnowledgeChunk = {
      id: `${source.docId}-${sanitizeId(sectionTitle)}-${counter}`,
      docId: source.docId,
      docTitle: source.docTitle,
      sectionTitle,
      sourceType: source.sourceType,
      moduleId: inferredModule,
      scopeType: source.scopeType,
      updatedAt,
      updatedAtTs: new Date(updatedAt).getTime(),
      version: updatedAt,
      keywords: extractKeywords(`${source.docTitle} ${sectionTitle} ${chunkContent}`).slice(0, 20),
      content: chunkContent,
      citation: `${source.fileName} / ${sectionTitle}`,
    };
    const tokens = tokenize(`${baseChunk.docTitle} ${baseChunk.sectionTitle} ${baseChunk.content}`);
    const tf = termFrequency(tokens);

    chunks.push({
      ...baseChunk,
      termFreq: tf,
      tokenSet: new Set(tf.keys()),
      bodyLength: Math.max(tokens.length, 1),
      tfidfNorm: 0,
    });
    counter += 1;
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > CHUNK_MAX_LENGTH && buffer.length >= CHUNK_MIN_LENGTH) {
      pushChunk();
      buffer = paragraph;
      continue;
    }
    buffer = candidate;
  }

  pushChunk();
  return chunks;
}

function buildSourceSignature(source: KnowledgeSourceDefinition) {
  const filePath = getSourceFilePath(source.fileName);
  if (!fs.existsSync(filePath)) {
    return 'missing';
  }

  const stats = fs.statSync(filePath);
  return `${stats.mtimeMs}:${stats.size}`;
}

function getSourceFilePath(fileName: string) {
  const workspaceRoot = getWorkspaceRoot();
  return path.join(workspaceRoot, fileName);
}

function buildMemoryChunks(records: MemoryRecord[]) {
  const chunks: IndexedKnowledgeChunk[] = [];
  const nowTs = Date.now();

  for (const record of records) {
    const sourceType: SourceType = 'memory';
    const scopeType: ScopeType = record.sessionId ? 'session' : record.tenantId ? 'tenant' : 'user';
    const scopeId = record.sessionId || record.tenantId || record.userId;
    const updatedAt = record.lastReinforcedAt || record.lastAccessAt || record.createdAt;
    const updatedAtTs = new Date(updatedAt).getTime();
    const content = normalizeText(record.content);
    if (!content) {
      continue;
    }

    const memoryModule = record.tags.find((tag) => MODULE_KEYWORDS.some((candidate) => candidate.moduleId === tag)) ?? inferModuleId(content);
    const decayScore = memoryDecayAt(record, nowTs);
    const tokens = tokenize(`${record.title} ${content}`);
    const tf = termFrequency(tokens);
    chunks.push({
      id: record.id,
      docId: 'memory-store',
      docTitle: 'Conversation Memory',
      sectionTitle: record.title,
      sourceType,
      moduleId: memoryModule,
      scopeType,
      scopeId,
      updatedAt,
      updatedAtTs,
      version: record.lastReinforcedAt || record.createdAt,
      keywords: Array.from(new Set([...extractKeywords(record.title + ' ' + content), ...record.tags])).slice(0, 20),
      content,
      citation: `memory:${record.userId}/${record.sessionId || record.tenantId || 'user'}#${record.tier}`,
      memoryTier: record.tier,
      memoryImportance: record.importance,
      memoryReinforcedCount: record.reinforcedCount,
      memoryDecayScore: decayScore,
      termFreq: tf,
      tokenSet: new Set(tf.keys()),
      bodyLength: Math.max(tokens.length, 1),
      tfidfNorm: 0,
    });
  }

  return chunks;
}

function buildMemoryStoreSignature(records: MemoryRecord[]) {
  if (records.length === 0) {
    return '0';
  }

  let maxUpdated = '';
  let reinforcedTotal = 0;
  let importanceFingerprint = 0;
  const tierCounts: Record<MemoryTier, number> = {
    working: 0,
    episodic: 0,
    semantic: 0,
    archive: 0,
  };
  for (const item of records) {
    const updated = item.lastReinforcedAt || item.lastAccessAt || item.createdAt;
    if (!maxUpdated || updated > maxUpdated) {
      maxUpdated = updated;
    }
    reinforcedTotal += item.reinforcedCount;
    importanceFingerprint += Math.round(item.importance * 1000);
    tierCounts[item.tier] += 1;
  }
  return `${records.length}:${maxUpdated}:${reinforcedTotal}:${importanceFingerprint}:${tierCounts.working}:${tierCounts.episodic}:${tierCounts.semantic}:${tierCounts.archive}`;
}

function buildIndexFromSources(): SourceBuildResult {
  const workspaceRoot = getWorkspaceRoot();
  const chunks: IndexedKnowledgeChunk[] = [];
  const sourceSignatures: Record<string, string> = {};

  for (const source of SOURCE_DEFINITIONS) {
    const filePath = path.join(workspaceRoot, source.fileName);
    sourceSignatures[source.docId] = buildSourceSignature(source);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = normalizeText(fs.readFileSync(filePath, 'utf8'));
    const updatedAt = fs.statSync(filePath).mtime.toISOString();
    const sections = source.fileName.endsWith('.md') ? splitMarkdownSections(content) : splitPlainTextSections(content);

    for (const section of sections) {
      chunks.push(...buildChunksFromSection(source, section.title, section.content, updatedAt));
    }
  }

  const memoryRecords = readMemoryRecords();
  const memoryChunks = buildMemoryChunks(memoryRecords);
  if (memoryChunks.length > 0) {
    chunks.push(...memoryChunks);
    sourceSignatures['memory-store'] = buildMemoryStoreSignature(memoryRecords);
  }

  return {
    chunks,
    sourceSignatures,
  };
}

function buildSignature(sourceSignatures: Record<string, string>) {
  return Object.entries(sourceSignatures)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([docId, signature]) => `${docId}:${signature}`)
    .join('|');
}

function buildIdfMap(chunks: IndexedKnowledgeChunk[]) {
  const docFreq = new Map<string, number>();

  for (const chunk of chunks) {
    for (const token of chunk.tokenSet) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const idfMap = new Map<string, number>();
  const total = chunks.length || 1;
  for (const [token, freq] of docFreq.entries()) {
    const idf = Math.log((total - freq + 0.5) / (freq + 0.5) + 1);
    idfMap.set(token, idf);
  }

  return idfMap;
}

function attachTfIdfNorm(chunks: IndexedKnowledgeChunk[], idfMap: Map<string, number>) {
  for (const chunk of chunks) {
    let norm = 0;
    for (const [token, freq] of chunk.termFreq.entries()) {
      const idf = idfMap.get(token) ?? 0;
      const weight = freq * idf;
      norm += weight * weight;
    }
    chunk.tfidfNorm = Math.sqrt(norm) || 1;
  }
}

function averageBodyLength(chunks: IndexedKnowledgeChunk[]) {
  if (chunks.length === 0) {
    return 1;
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.bodyLength, 0);
  return total / chunks.length;
}

function readManifest(): RagManifest | null {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RagManifest;
    if (typeof parsed !== 'object' || !parsed) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeManifest(manifest: RagManifest) {
  const manifestPath = getManifestPath();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

function getChangedDocIds(previous: RagManifest | null, currentSignatures: Record<string, string>) {
  const allDocIds = Object.keys(currentSignatures);
  if (!previous) {
    return allDocIds;
  }

  return allDocIds.filter((docId) => previous.sourceSignatures[docId] !== currentSignatures[docId]);
}

function getRemovedDocIds(previous: RagManifest | null, currentSignatures: Record<string, string>) {
  if (!previous) {
    return [];
  }
  return Object.keys(previous.sourceSignatures).filter((docId) => !(docId in currentSignatures));
}

function parseSourceType(value: string): SourceType | null {
  if (
    value === 'project_doc' ||
    value === 'business_rule' ||
    value === 'report_definition' ||
    value === 'api_spec' ||
    value === 'db_spec' ||
    value === 'memory'
  ) {
    return value;
  }
  return null;
}

function inferKnowledgeQueryOptionsInternal(prompt: string): KnowledgeQueryInferredOptions {
  const normalized = prompt.toLowerCase();
  const moduleIds = MODULE_KEYWORDS.filter((candidate) => candidate.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))).map(
    (candidate) => candidate.moduleId,
  );
  const sourceTypes = SOURCE_TYPE_KEYWORDS.filter((candidate) =>
    candidate.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())),
  ).map((candidate) => candidate.sourceType);
  const docIds = DOC_KEYWORDS.filter((candidate) => candidate.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))).map(
    (candidate) => candidate.docId,
  );

  return {
    moduleIds: Array.from(new Set(moduleIds)),
    sourceTypes: Array.from(new Set(sourceTypes)),
    docIds: Array.from(new Set(docIds)),
  };
}

export function inferKnowledgeQueryOptions(prompt: string): KnowledgeQueryInferredOptions {
  return inferKnowledgeQueryOptionsInternal(prompt);
}

function mergeOptions(prompt: string, options: KnowledgeQueryOptions): RetrievalMergedOptions {
  const inferred = inferKnowledgeQueryOptionsInternal(prompt);
  const limit = Math.max(1, Math.min(10, options.limit ?? env.ragTopK ?? 3));
  const candidateLimit = Math.max(limit + 2, Math.min(80, options.candidateLimit ?? env.ragCandidateK ?? 18));
  const minScore = clamp(options.minScore ?? env.ragMinScore ?? 0.18, 0, 2);

  const sourceTypes = (options.sourceTypes && options.sourceTypes.length > 0 ? options.sourceTypes : inferred.sourceTypes)
    .map((item) => parseSourceType(item))
    .filter((item): item is SourceType => item != null);

  return {
    limit,
    candidateLimit,
    minScore,
    retrievalMode: options.retrievalMode ?? parseRetrievalMode(env.ragRetrievalMode),
    scope: options.scope ?? parseScope(env.ragScopeDefault),
    moduleIds: options.moduleIds && options.moduleIds.length > 0 ? options.moduleIds : inferred.moduleIds,
    sourceTypes,
    docIds: options.docIds && options.docIds.length > 0 ? options.docIds : inferred.docIds,
    userId: options.userId?.trim() || undefined,
    tenantId: options.tenantId?.trim() || undefined,
    sessionId: options.sessionId?.trim() || undefined,
    fromTs: options.fromTs,
    toTs: options.toTs,
  };
}

function applyMetadataFilters(chunks: IndexedKnowledgeChunk[], options: RetrievalMergedOptions) {
  return chunks.filter((chunk) => {
    if (options.moduleIds.length > 0 && !options.moduleIds.includes(chunk.moduleId)) {
      return false;
    }
    if (options.sourceTypes.length > 0 && !options.sourceTypes.includes(chunk.sourceType)) {
      return false;
    }
    if (options.docIds.length > 0 && !options.docIds.includes(chunk.docId)) {
      return false;
    }
    if (options.scope === 'global' && chunk.scopeType !== 'global') {
      return false;
    }
    if (options.scope === 'module' && chunk.scopeType !== 'module') {
      return false;
    }
    if (options.scope === 'tenant') {
      if (chunk.scopeType !== 'tenant') {
        return false;
      }
      if (!options.tenantId || chunk.scopeId !== options.tenantId) {
        return false;
      }
    }
    if (options.scope === 'user') {
      if (chunk.scopeType !== 'user') {
        return false;
      }
      if (!options.userId || chunk.scopeId !== options.userId) {
        return false;
      }
    }
    if (options.scope === 'session') {
      if (chunk.scopeType !== 'session') {
        return false;
      }
      if (!options.sessionId || chunk.scopeId !== options.sessionId) {
        return false;
      }
    }
    if (options.scope === 'all') {
      if (chunk.scopeType === 'tenant' && options.tenantId && chunk.scopeId !== options.tenantId) {
        return false;
      }
      if (chunk.scopeType === 'user' && options.userId && chunk.scopeId !== options.userId) {
        return false;
      }
      if (chunk.scopeType === 'session' && options.sessionId && chunk.scopeId !== options.sessionId) {
        return false;
      }
      if (chunk.scopeType === 'tenant' && !options.tenantId) {
        return false;
      }
      if (chunk.scopeType === 'session' && !options.sessionId) {
        return false;
      }
      if (chunk.scopeType === 'user' && !options.userId) {
        return false;
      }
    }
    if ((chunk.scopeType === 'tenant' || chunk.scopeType === 'user' || chunk.scopeType === 'session') && !chunk.scopeId) {
      return false;
    }
    if (Number.isFinite(options.fromTs) && chunk.updatedAtTs < Number(options.fromTs)) {
      return false;
    }
    if (Number.isFinite(options.toTs) && chunk.updatedAtTs > Number(options.toTs)) {
      return false;
    }
    return true;
  });
}

function normalizeScores(items: Array<{ key: string; value: number }>) {
  if (items.length === 0) {
    return new Map<string, number>();
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    min = Math.min(min, item.value);
    max = Math.max(max, item.value);
  }

  const map = new Map<string, number>();
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-8) {
    for (const item of items) {
      map.set(item.key, item.value > 0 ? 1 : 0);
    }
    return map;
  }

  for (const item of items) {
    map.set(item.key, clamp((item.value - min) / (max - min), 0, 1));
  }

  return map;
}

function bm25Score(chunk: IndexedKnowledgeChunk, queryTf: Map<string, number>, idfMap: Map<string, number>, avgLength: number) {
  let score = 0;

  for (const [token, qf] of queryTf.entries()) {
    const tf = chunk.termFreq.get(token) ?? 0;
    if (tf <= 0) {
      continue;
    }

    const idf = idfMap.get(token) ?? 0;
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.bodyLength / Math.max(avgLength, 1)));
    score += idf * (numerator / Math.max(denominator, 1e-6)) * Math.max(1, qf * 0.5);
  }

  return score;
}

function tfidfDenseScore(chunk: IndexedKnowledgeChunk, queryTf: Map<string, number>, idfMap: Map<string, number>) {
  let dot = 0;
  let queryNorm = 0;

  for (const [token, qf] of queryTf.entries()) {
    const idf = idfMap.get(token) ?? 0;
    const qWeight = qf * idf;
    queryNorm += qWeight * qWeight;
    const dWeight = (chunk.termFreq.get(token) ?? 0) * idf;
    dot += qWeight * dWeight;
  }

  const denominator = Math.sqrt(queryNorm) * chunk.tfidfNorm;
  if (!Number.isFinite(denominator) || denominator <= 1e-8) {
    return 0;
  }

  return clamp(dot / denominator, 0, 1);
}

function recencyScore(updatedAtTs: number) {
  const halfLifeDays = toPositiveNumber(env.ragRecencyHalfLifeDays, 45);
  const ageDays = Math.max(0, (Date.now() - updatedAtTs) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / halfLifeDays);
}

function memoryGovernanceBoost(chunk: IndexedKnowledgeChunk) {
  if (chunk.sourceType !== 'memory') {
    return 1;
  }

  const tier = chunk.memoryTier ?? 'working';
  const tierWeight = MEMORY_TIER_WEIGHT[tier] ?? 0.92;
  const importance = clamp(chunk.memoryImportance ?? 0.5, 0, 1);
  const reinforced = Math.max(1, chunk.memoryReinforcedCount ?? 1);
  const decay = clamp(chunk.memoryDecayScore ?? recencyScore(chunk.updatedAtTs), 0, 1);
  const reinforceBoost = Math.min(0.14, Math.log2(reinforced + 1) * 0.035);

  const boost = 0.78 + (tierWeight - 0.9) * 0.45 + importance * 0.2 + decay * 0.09 + reinforceBoost;
  return clamp(boost, 0.66, 1.3);
}

function inferPromptPhrases(prompt: string) {
  return prompt
    .toLowerCase()
    .split(/[，。！？；、\s]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function rerankScore(prompt: string, chunk: IndexedKnowledgeChunk, baseHybridScore: number, queryTokenSet: Set<string>) {
  const lowerPrompt = prompt.toLowerCase();
  const titleText = `${chunk.docTitle} ${chunk.sectionTitle}`.toLowerCase();
  const bodyText = chunk.content.toLowerCase();
  const phrases = inferPromptPhrases(prompt);

  let phraseBoost = 0;
  for (const phrase of phrases) {
    if (titleText.includes(phrase)) {
      phraseBoost += Math.min(0.18, 0.04 + phrase.length * 0.002);
    } else if (bodyText.includes(phrase)) {
      phraseBoost += Math.min(0.09, 0.02 + phrase.length * 0.0016);
    }
  }

  let matchedCount = 0;
  for (const token of queryTokenSet) {
    if (chunk.tokenSet.has(token)) {
      matchedCount += 1;
    }
  }
  const coverageRatio = queryTokenSet.size > 0 ? matchedCount / queryTokenSet.size : 0;

  let citationBoost = 0;
  if (lowerPrompt.includes(chunk.docTitle.toLowerCase())) {
    citationBoost += 0.08;
  }
  if (lowerPrompt.includes(chunk.sectionTitle.toLowerCase())) {
    citationBoost += 0.06;
  }

  return clamp(baseHybridScore * 0.72 + coverageRatio * 0.2 + phraseBoost + citationBoost, 0, 1.6);
}

function getRerankProvider() {
  const provider = (env.ragRerankProvider || 'heuristic').trim().toLowerCase();
  if (provider === 'jina' || provider === 'cohere' || provider === 'custom') {
    return provider;
  }
  return 'heuristic';
}

function rerankApiConfigured() {
  if (!env.ragRerankEnabled) {
    return false;
  }
  const provider = getRerankProvider();
  if (provider === 'heuristic') {
    return false;
  }
  return Boolean(env.ragRerankBaseUrl && env.ragRerankModel);
}

function getRerankEndpoint() {
  const provider = getRerankProvider();
  const base = (env.ragRerankBaseUrl || '').replace(/\/$/, '');
  if (!base) {
    return '';
  }

  if (provider === 'jina') {
    return base.endsWith('/v1/rerank') ? base : `${base}/v1/rerank`;
  }
  if (provider === 'cohere') {
    return base.endsWith('/v2/rerank') ? base : `${base}/v2/rerank`;
  }
  return base;
}

function parseRerankResults(payload: unknown) {
  const data = payload as
    | {
        results?: unknown[];
        data?: unknown[];
      }
    | undefined;
  const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : [];
  const parsed = rows
    .map((item) => {
      const row = item as
        | {
            index?: unknown;
            document_index?: unknown;
            relevance_score?: unknown;
            score?: unknown;
          }
        | undefined;
      const index = Number(row?.index ?? row?.document_index);
      const score = Number(row?.relevance_score ?? row?.score);
      if (!Number.isFinite(index) || !Number.isFinite(score)) {
        return null;
      }
      return {
        index,
        score: clamp(score, 0, 1),
      };
    })
    .filter((item): item is { index: number; score: number } => item != null);

  return parsed;
}

async function requestRemoteRerank(prompt: string, candidates: RetrievalCandidate[]) {
  if (!rerankApiConfigured() || candidates.length === 0) {
    return null;
  }

  const endpoint = getRerankEndpoint();
  if (!endpoint) {
    return null;
  }

  const topN = Math.max(1, Math.min(candidates.length, env.ragRerankTopN || candidates.length));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (env.ragRerankApiKey) {
    headers.Authorization = `Bearer ${env.ragRerankApiKey}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: env.ragRerankModel,
      query: prompt,
      documents: candidates.map((item) => item.indexed.content),
      top_n: topN,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message =
      (payload as { error?: string; message?: string } | null)?.error ||
      (payload as { error?: string; message?: string } | null)?.message ||
      `rerank request failed: ${response.status}`;
    throw new Error(message);
  }

  const parsed = parseRerankResults(payload);
  if (parsed.length === 0) {
    return null;
  }

  const scoreMap = new Map<string, number>();
  for (const item of parsed) {
    if (item.index < 0 || item.index >= candidates.length) {
      continue;
    }
    scoreMap.set(candidates[item.index].indexed.id, item.score);
  }
  return scoreMap;
}

function jaccardSimilarity(left: IndexedKnowledgeChunk, right: IndexedKnowledgeChunk) {
  if (left.tokenSet.size === 0 || right.tokenSet.size === 0) {
    return 0;
  }

  let intersection = 0;
  const smaller = left.tokenSet.size <= right.tokenSet.size ? left.tokenSet : right.tokenSet;
  const larger = smaller === left.tokenSet ? right.tokenSet : left.tokenSet;

  for (const token of smaller) {
    if (larger.has(token)) {
      intersection += 1;
    }
  }

  const union = left.tokenSet.size + right.tokenSet.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function sanitizeVector(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }
  const values = input.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  const dim = toPositiveNumber(env.ragEmbeddingDimensions, 0);
  if (dim <= 0) {
    return values;
  }
  if (values.length > dim) {
    return values.slice(0, dim);
  }
  if (values.length < dim) {
    return [...values, ...new Array(dim - values.length).fill(0)];
  }
  return values;
}

function cosineSimilarity(left: number[] | undefined, right: number[] | undefined) {
  if (!left || !right || left.length === 0 || right.length === 0) {
    return 0;
  }
  const dim = Math.min(left.length, right.length);
  if (dim <= 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < dim; index += 1) {
    const l = left[index];
    const r = right[index];
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denominator) || denominator <= 1e-8) {
    return 0;
  }
  return clamp((dot / denominator + 1) / 2, 0, 1);
}

function applyMmrSelection(candidates: RetrievalCandidate[], limit: number, lambda: number) {
  if (candidates.length <= limit) {
    return candidates;
  }

  const selected: RetrievalCandidate[] = [];
  const remaining = [...candidates];
  const clampedLambda = clamp(lambda, 0, 1);

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const relevance = candidate.rerankScore;
      let maxSimilarity = 0;

      for (const chosen of selected) {
        const vectorSim = cosineSimilarity(candidate.indexed.vector, chosen.indexed.vector);
        const lexicalSim = jaccardSimilarity(candidate.indexed, chosen.indexed);
        const similarity = vectorSim > 0 ? vectorSim : lexicalSim;
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }

      const score = clampedLambda * relevance - (1 - clampedLambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    selected.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }

  return selected;
}

function toRetrievedChunk(item: RetrievalCandidate): RetrievedKnowledgeChunk {
  return {
    id: item.indexed.id,
    docId: item.indexed.docId,
    docTitle: item.indexed.docTitle,
    sectionTitle: item.indexed.sectionTitle,
    sourceType: item.indexed.sourceType,
    moduleId: item.indexed.moduleId,
    scopeType: item.indexed.scopeType,
    scopeId: item.indexed.scopeId,
    updatedAt: item.indexed.updatedAt,
    updatedAtTs: item.indexed.updatedAtTs,
    version: item.indexed.version,
    keywords: item.indexed.keywords,
    content: item.indexed.content,
    citation: item.indexed.citation,
    score: item.rerankScore,
    denseScore: item.denseScore,
    lexicalScore: item.lexicalScore,
    recencyScore: item.recencyScore,
    rerankScore: item.rerankScore,
  };
}

function topEntries(scoreMap: Map<string, number>, limit: number) {
  return Array.from(scoreMap.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([id]) => id);
}

const RETRIEVAL_SKIP_PATTERNS = [/^(hi|hello|hey)\b/i, /^(你好|您好|在吗|在不在|谢谢|多谢|收到|好的|ok|嗯嗯|哈哈)\s*$/i];
const RETRIEVAL_FORCE_PATTERNS = [/上次|之前|刚才|继续|延续|记得/i, /规则|口径|依据|来源|文档|报表|接口|表结构|权限|策略/i];

function shouldSkipRetrieval(prompt: string) {
  const normalized = prompt.trim();
  if (normalized.length <= 2) {
    return true;
  }
  if (normalized.length <= 12 && RETRIEVAL_SKIP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return false;
}

function shouldForceRetrieval(prompt: string) {
  return RETRIEVAL_FORCE_PATTERNS.some((pattern) => pattern.test(prompt));
}

function getEmbeddingProvider() {
  const provider = (env.ragEmbeddingProvider || 'openai').trim().toLowerCase();
  return provider === 'ollama' ? 'ollama' : 'openai';
}

function embeddingConfigured() {
  if (!env.ragEmbeddingModel || !env.ragEmbeddingBaseUrl) {
    return false;
  }
  if (getEmbeddingProvider() === 'ollama') {
    return true;
  }
  return Boolean(env.ragEmbeddingApiKey || env.deepseekApiKey);
}

function getEmbeddingApiKey() {
  return env.ragEmbeddingApiKey || env.deepseekApiKey || '';
}

function getOpenAiEmbeddingEndpoint() {
  const base = (env.ragEmbeddingBaseUrl || '').replace(/\/$/, '');
  if (!base) {
    return '';
  }
  return base.endsWith('/embeddings') ? base : `${base}/embeddings`;
}

function getOllamaEmbeddingEndpoints() {
  const base = (env.ragEmbeddingBaseUrl || '').replace(/\/$/, '');
  if (!base) {
    return [];
  }

  if (base.endsWith('/api/embed') || base.endsWith('/api/embeddings')) {
    return [base];
  }
  if (base.endsWith('/api')) {
    return [`${base}/embed`, `${base}/embeddings`];
  }
  return [`${base}/api/embed`, `${base}/api/embeddings`];
}

async function importDynamic(moduleName: string): Promise<any | null> {
  try {
    const importer = new Function('moduleName', 'return import(moduleName);') as (name: string) => Promise<any>;
    return await importer(moduleName);
  } catch {
    return null;
  }
}

async function loadLanceDbModule() {
  if (!env.ragLancedbEnabled) {
    return null;
  }

  const byScoped = await importDynamic('@lancedb/lancedb');
  if (byScoped) {
    return byScoped;
  }
  return importDynamic('vectordb');
}

function resetLanceContext() {
  lanceContextPromise = null;
}

async function openLanceContext(): Promise<LanceDbContext | null> {
  if (lanceContextPromise) {
    return lanceContextPromise;
  }

  lanceContextPromise = (async () => {
    const module = await loadLanceDbModule();
    if (!module || typeof module.connect !== 'function') {
      return null;
    }

    const dbPath = env.ragLancedbDir || path.resolve(process.cwd(), 'database', 'rag', 'lancedb');
    fs.mkdirSync(dbPath, { recursive: true });
    const db = await module.connect(dbPath);

    try {
      const table = await db.openTable(env.ragLancedbTable);
      return { db, table, module };
    } catch {
      return { db, table: null, module };
    }
  })();

  return lanceContextPromise;
}

async function ensureLanceTable(context: LanceDbContext, initialRows: LanceChunkRow[]) {
  if (context.table) {
    return context.table;
  }

  if (initialRows.length === 0) {
    return null;
  }

  let table: any = null;
  try {
    table = await context.db.createTable(env.ragLancedbTable, initialRows);
  } catch {
    table = await context.db.createTable(env.ragLancedbTable, initialRows, { mode: 'overwrite' });
  }

  context.table = table;
  return table;
}

async function consumeLanceQuery(query: any) {
  if (!query) {
    return [];
  }

  if (typeof query.toArray === 'function') {
    return await query.toArray();
  }
  if (typeof query.execute === 'function') {
    return await query.execute();
  }
  if (typeof query.toList === 'function') {
    return await query.toList();
  }
  if (Array.isArray(query)) {
    return query;
  }
  return [];
}

function mapRowScore(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value >= 0 && value <= 1) {
    return value;
  }
  if (value < 0) {
    return clamp(1 / (1 + Math.abs(value)), 0, 1);
  }
  return clamp(1 / (1 + value), 0, 1);
}

function extractLanceResult(rows: any[]): LanceResultScore[] {
  const results: LanceResultScore[] = [];
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!id) {
      continue;
    }
    const scoreCandidate = Number(row?._score ?? row?.score ?? row?._distance ?? row?.distance ?? 0);
    const vector = sanitizeVector(row?.vector);
    const result: LanceResultScore = {
      id,
      score: mapRowScore(scoreCandidate),
    };
    if (vector.length > 0) {
      result.vector = vector;
    }
    results.push(result);
  }
  return results;
}

function escapeQuoted(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function deleteRowsByDocIds(table: any, docIds: string[]) {
  for (const docId of docIds) {
    const predicate = `docId = '${escapeQuoted(docId)}'`;
    try {
      await table.delete(predicate);
    } catch {
      // no-op
    }
  }
}

async function ensureFtsIndex(table: any, module: any) {
  if (!table) {
    return;
  }

  try {
    if (typeof table.createFtsIndex === 'function') {
      await table.createFtsIndex('content');
      return;
    }
    if (typeof table.createFTSIndex === 'function') {
      await table.createFTSIndex('content');
      return;
    }
    if (typeof table.createIndex === 'function') {
      if (module?.Index?.fts) {
        await table.createIndex('content', { config: module.Index.fts() });
      } else {
        await table.createIndex('content');
      }
    }
  } catch {
    // no-op
  }
}

async function requestOpenAiEmbeddings(input: string[]) {
  const endpoint = getOpenAiEmbeddingEndpoint();
  if (!endpoint) {
    return null;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = getEmbeddingApiKey();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: env.ragEmbeddingModel,
      input,
      dimensions: toPositiveNumber(env.ragEmbeddingDimensions, 0) || undefined,
    }),
  });

  const payload = (await response.json()) as {
    data?: Array<{
      embedding?: unknown;
      index?: number;
    }>;
    error?: {
      message?: string;
    };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message || `embedding request failed: ${response.status}`);
  }

  const ordered = (payload.data ?? [])
    .slice()
    .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
    .map((item) => sanitizeVector(item.embedding));

  if (ordered.length !== input.length) {
    throw new Error(`embedding response length mismatch, expected ${input.length}, got ${ordered.length}`);
  }

  return ordered;
}

function parseOllamaEmbedPayload(payload: unknown, expectedLength: number) {
  const data = payload as
    | {
        embeddings?: unknown;
        embedding?: unknown;
      }
    | undefined;

  if (Array.isArray(data?.embeddings)) {
    const vectors = data.embeddings.map((item) => sanitizeVector(item));
    if (vectors.length === expectedLength) {
      return vectors;
    }
  }

  if (Array.isArray(data?.embedding) && expectedLength === 1) {
    return [sanitizeVector(data.embedding)];
  }

  return null;
}

async function requestOllamaBatchEmbedding(endpoint: string, input: string[]) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ragEmbeddingModel,
      input,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message =
      (payload as { error?: string; message?: string } | null)?.error ||
      (payload as { error?: string; message?: string } | null)?.message ||
      `ollama embedding request failed: ${response.status}`;
    throw new Error(message);
  }

  const parsed = parseOllamaEmbedPayload(payload, input.length);
  if (!parsed) {
    throw new Error('ollama /api/embed payload parsing failed');
  }
  return parsed;
}

async function requestOllamaSingleEmbedding(endpoint: string, prompt: string) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ragEmbeddingModel,
      prompt,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message =
      (payload as { error?: string; message?: string } | null)?.error ||
      (payload as { error?: string; message?: string } | null)?.message ||
      `ollama embedding request failed: ${response.status}`;
    throw new Error(message);
  }

  const parsed = parseOllamaEmbedPayload(payload, 1);
  if (!parsed || parsed.length !== 1) {
    throw new Error('ollama /api/embeddings payload parsing failed');
  }
  return parsed[0];
}

async function requestOllamaEmbeddings(input: string[]) {
  const endpoints = getOllamaEmbeddingEndpoints();
  if (endpoints.length === 0) {
    return null;
  }

  let lastError = '';
  for (const endpoint of endpoints) {
    try {
      if (endpoint.endsWith('/api/embed') || endpoint.endsWith('/embed')) {
        return await requestOllamaBatchEmbedding(endpoint, input);
      }

      if (endpoint.endsWith('/api/embeddings') || endpoint.endsWith('/embeddings')) {
        const vectors: number[][] = [];
        for (const prompt of input) {
          vectors.push(await requestOllamaSingleEmbedding(endpoint, prompt));
        }
        return vectors;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unknown ollama embedding error';
    }
  }

  throw new Error(lastError || 'ollama embedding request failed');
}

async function requestEmbeddings(input: string[]) {
  if (input.length === 0 || !embeddingConfigured()) {
    return null;
  }

  const provider = getEmbeddingProvider();
  if (provider === 'ollama') {
    return requestOllamaEmbeddings(input);
  }
  return requestOpenAiEmbeddings(input);
}

async function buildEmbeddingsForChunks(chunks: IndexedKnowledgeChunk[]) {
  const vectors = new Map<string, number[]>();
  if (chunks.length === 0 || !embeddingConfigured()) {
    return vectors;
  }

  const batchSize = Math.max(1, Math.min(64, toPositiveNumber(env.ragEmbeddingBatchSize, 24)));
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const slice = chunks.slice(offset, offset + batchSize);
    const embeddings = await requestEmbeddings(slice.map((item) => item.content));
    if (!embeddings) {
      continue;
    }
    for (let index = 0; index < slice.length; index += 1) {
      const vector = embeddings[index];
      if (vector.length > 0) {
        vectors.set(slice[index].id, vector);
      }
    }
  }

  return vectors;
}

async function getQueryEmbedding(prompt: string) {
  const key = prompt.trim().toLowerCase();
  if (queryEmbeddingCache.has(key)) {
    return queryEmbeddingCache.get(key) ?? [];
  }

  const response = await requestEmbeddings([prompt]);
  const vector = response?.[0] ?? [];
  if (vector.length > 0) {
    queryEmbeddingCache.set(key, vector);
  }
  return vector;
}

function toLanceRows(chunks: IndexedKnowledgeChunk[], vectors: Map<string, number[]>) {
  const rows: LanceChunkRow[] = [];
  for (const chunk of chunks) {
    const vector = vectors.get(chunk.id);
    if (!vector || vector.length === 0) {
      continue;
    }
    rows.push({
      id: chunk.id,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      sectionTitle: chunk.sectionTitle,
      sourceType: chunk.sourceType,
      moduleId: chunk.moduleId,
      scope: chunk.scopeType,
      scopeId: chunk.scopeId,
      updatedAt: chunk.updatedAt,
      updatedAtTs: chunk.updatedAtTs,
      version: chunk.version,
      keywords: chunk.keywords,
      content: chunk.content,
      citation: chunk.citation,
      metadata: JSON.stringify({
        sourceType: chunk.sourceType,
        moduleId: chunk.moduleId,
        scope: chunk.scopeType,
        scopeId: chunk.scopeId,
        keywords: chunk.keywords,
        docId: chunk.docId,
        memoryTier: chunk.memoryTier,
        memoryImportance: chunk.memoryImportance,
        memoryReinforcedCount: chunk.memoryReinforcedCount,
        memoryDecayScore: chunk.memoryDecayScore,
      }),
      ts: chunk.updatedAtTs,
      vector,
    });
  }
  return rows;
}

async function syncLanceDb(
  chunks: IndexedKnowledgeChunk[],
  sourceSignatures: Record<string, string>,
  options: { force: boolean; incremental: boolean },
): Promise<LanceDbSyncResult> {
  if (!env.ragLancedbEnabled) {
    return {
      enabled: false,
      available: false,
      indexedRows: 0,
      changedDocIds: [],
      removedDocIds: [],
      lastError: 'RAG_LANCEDB_ENABLED is false',
    };
  }

  if (!embeddingConfigured()) {
    return {
      enabled: false,
      available: false,
      indexedRows: 0,
      changedDocIds: [],
      removedDocIds: [],
      lastError: 'embedding is not configured',
    };
  }

  const context = await openLanceContext();
  if (!context) {
    return {
      enabled: false,
      available: false,
      indexedRows: 0,
      changedDocIds: [],
      removedDocIds: [],
      lastError: 'lancedb package not available',
    };
  }

  const previousManifest = readManifest();
  let changedDocIds = getChangedDocIds(previousManifest, sourceSignatures);
  const removedDocIds = getRemovedDocIds(previousManifest, sourceSignatures);
  const modelChanged =
    previousManifest &&
    (previousManifest.embeddingProvider !== getEmbeddingProvider() ||
      previousManifest.embeddingModel !== env.ragEmbeddingModel ||
      previousManifest.embeddingBaseUrl !== env.ragEmbeddingBaseUrl);

  if (options.force || !options.incremental || modelChanged || !context.table) {
    changedDocIds = Object.keys(sourceSignatures);
  }

  const changedSet = new Set(changedDocIds);
  const changedChunks = chunks.filter((chunk) => changedSet.has(chunk.docId));

  if (changedDocIds.length === 0 && removedDocIds.length === 0 && context.table) {
    return {
      enabled: true,
      available: true,
      indexedRows: chunks.length,
      changedDocIds: [],
      removedDocIds: [],
      lastError: '',
    };
  }

  const vectors = await buildEmbeddingsForChunks(changedChunks);
  const rows = toLanceRows(changedChunks, vectors);

  const table = await ensureLanceTable(context, rows);
  if (!table) {
    return {
      enabled: false,
      available: true,
      indexedRows: 0,
      changedDocIds,
      removedDocIds,
      lastError: 'no rows to index',
    };
  }

  if (context.table) {
    await deleteRowsByDocIds(table, [...changedDocIds, ...removedDocIds]);
    if (rows.length > 0) {
      await table.add(rows);
    }
  }

  await ensureFtsIndex(table, context.module);
  const manifest: RagManifest = {
    version: 2,
    updatedAt: new Date().toISOString(),
    sourceSignatures,
    chunkCount: chunks.length,
    embeddingProvider: getEmbeddingProvider(),
    embeddingModel: env.ragEmbeddingModel,
    embeddingBaseUrl: env.ragEmbeddingBaseUrl,
  };
  writeManifest(manifest);

  resetLanceContext();
  return {
    enabled: true,
    available: true,
    indexedRows: rows.length,
    changedDocIds,
    removedDocIds,
    lastError: '',
  };
}

async function refreshKnowledgeIndex(options: { force: boolean; incremental: boolean }) {
  const built = buildIndexFromSources();
  const signature = buildSignature(built.sourceSignatures);
  if (!options.force && cache.signature === signature && cache.chunks.length > 0) {
    return cache;
  }

  const idfMap = buildIdfMap(built.chunks);
  attachTfIdfNorm(built.chunks, idfMap);
  const average = averageBodyLength(built.chunks);
  const chunkMap = new Map(built.chunks.map((chunk) => [chunk.id, chunk]));

  const nextCache: KnowledgeIndexCache = {
    signature,
    chunks: built.chunks,
    chunkMap,
    idfMap,
    averageBodyLength: average,
    refreshedAt: new Date().toISOString(),
  };

  try {
    const syncResult = await syncLanceDb(built.chunks, built.sourceSignatures, options);
    lanceState = {
      ...lanceState,
      enabled: syncResult.enabled,
      available: syncResult.available,
      tableName: env.ragLancedbTable || 'knowledge_chunks',
      dbPath: env.ragLancedbDir || path.resolve(process.cwd(), 'database', 'rag', 'lancedb'),
      indexedRows: syncResult.indexedRows,
      changedDocIds: syncResult.changedDocIds,
      removedDocIds: syncResult.removedDocIds,
      lastSyncAt: new Date().toISOString(),
      lastError: syncResult.lastError,
    };
  } catch (error) {
    lanceState = {
      ...lanceState,
      enabled: false,
      available: false,
      tableName: env.ragLancedbTable || 'knowledge_chunks',
      dbPath: env.ragLancedbDir || path.resolve(process.cwd(), 'database', 'rag', 'lancedb'),
      lastSyncAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : 'unknown lancedb error',
    };
  }

  cache = nextCache;
  return cache;
}

async function ensureKnowledgeIndex(options: { force: boolean; incremental: boolean } = { force: false, incremental: true }) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = refreshKnowledgeIndex(options).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function searchVectorByLanceDb(queryVector: number[], limit: number) {
  const context = await openLanceContext();
  if (!context?.table || queryVector.length === 0) {
    return [];
  }

  try {
    let query = context.table.search(queryVector);
    if (typeof query.limit === 'function') {
      query = query.limit(limit);
    }
    return extractLanceResult(await consumeLanceQuery(query));
  } catch {
    return [];
  }
}

async function searchFtsByLanceDb(prompt: string, limit: number) {
  const context = await openLanceContext();
  if (!context?.table || !prompt.trim()) {
    return [];
  }

  try {
    let query = context.table.search(prompt);
    if (typeof query.queryType === 'function') {
      query = query.queryType('fts');
    }
    if (typeof query.limit === 'function') {
      query = query.limit(limit);
    }
    return extractLanceResult(await consumeLanceQuery(query));
  } catch {
    return [];
  }
}

function mergeScoreMaps(items: LanceResultScore[]) {
  return normalizeScores(items.map((item) => ({ key: item.id, value: item.score })));
}

async function buildRetrievalScores(
  prompt: string,
  queryTf: Map<string, number>,
  pool: IndexedKnowledgeChunk[],
  options: RetrievalMergedOptions,
): Promise<RetrievalScoreMaps> {
  const lexicalBm25Raw = pool.map((chunk) => ({
    key: chunk.id,
    value: bm25Score(chunk, queryTf, cache.idfMap, cache.averageBodyLength),
  }));
  const denseTfidfRaw = pool.map((chunk) => ({
    key: chunk.id,
    value: tfidfDenseScore(chunk, queryTf, cache.idfMap),
  }));

  const lexicalBm25 = normalizeScores(lexicalBm25Raw);
  const denseTfidf = normalizeScores(denseTfidfRaw);

  const vectorScores = new Map<string, number>();
  const lexicalFtsScores = new Map<string, number>();
  const vectorMap = new Map<string, number[]>();
  const vectorLimit = Math.max(options.candidateLimit, env.ragVectorCandidateK ?? options.candidateLimit);
  const ftsLimit = Math.max(options.candidateLimit, env.ragFtsCandidateK ?? options.candidateLimit);

  if (options.retrievalMode === 'dense' || options.retrievalMode === 'hybrid') {
    const queryVector = await getQueryEmbedding(prompt);
    if (queryVector.length > 0) {
      const vectorRows = await searchVectorByLanceDb(queryVector, vectorLimit);
      const normalized = mergeScoreMaps(vectorRows);
      for (const [id, score] of normalized.entries()) {
        vectorScores.set(id, score);
      }
      for (const row of vectorRows) {
        if (row.vector && row.vector.length > 0) {
          vectorMap.set(row.id, row.vector);
        }
      }
    }
  }

  if (options.retrievalMode === 'lexical' || options.retrievalMode === 'hybrid') {
    const ftsRows = await searchFtsByLanceDb(prompt, ftsLimit);
    const normalized = mergeScoreMaps(ftsRows);
    for (const [id, score] of normalized.entries()) {
      lexicalFtsScores.set(id, score);
    }
  }

  return {
    dense: vectorScores.size > 0 ? vectorScores : denseTfidf,
    lexical: lexicalFtsScores.size > 0 ? lexicalFtsScores : lexicalBm25,
    denseVectors: vectorMap,
  };
}

function pickCandidates(
  pool: IndexedKnowledgeChunk[],
  denseScores: Map<string, number>,
  lexicalScores: Map<string, number>,
  limit: number,
) {
  const poolIds = new Set(pool.map((chunk) => chunk.id));
  const candidateIds = new Set<string>([
    ...topEntries(denseScores, limit),
    ...topEntries(lexicalScores, limit),
  ]);

  if (candidateIds.size === 0) {
    for (const chunk of pool.slice(0, limit)) {
      candidateIds.add(chunk.id);
    }
  }

  return Array.from(candidateIds)
    .map((id) => cache.chunkMap.get(id))
    .filter((chunk): chunk is IndexedKnowledgeChunk => chunk != null && poolIds.has(chunk.id));
}

async function rankCandidates(
  prompt: string,
  queryTokens: Set<string>,
  candidates: IndexedKnowledgeChunk[],
  scores: RetrievalScoreMaps,
  options: RetrievalMergedOptions,
) {
  const lexicalWeight = clamp(env.ragLexicalWeight ?? 0.48, 0, 1);
  const denseWeight = clamp(env.ragDenseWeight ?? 0.42, 0, 1);
  const recencyWeight = clamp(1 - lexicalWeight - denseWeight, 0, 0.4);

  const ranked = candidates.map((chunk) => {
    const dense = scores.dense.get(chunk.id) ?? 0;
    const lexical = scores.lexical.get(chunk.id) ?? 0;
    const recency = recencyScore(chunk.updatedAtTs);
    if (scores.denseVectors.has(chunk.id)) {
      chunk.vector = scores.denseVectors.get(chunk.id);
    }

    let hybrid = lexicalWeight * lexical + denseWeight * dense + recencyWeight * recency;
    if (options.retrievalMode === 'dense') {
      hybrid = 0.84 * dense + 0.16 * recency;
    } else if (options.retrievalMode === 'lexical') {
      hybrid = 0.84 * lexical + 0.16 * recency;
    }
    hybrid = clamp(hybrid * memoryGovernanceBoost(chunk), 0, 1.6);

    const rerank = env.ragRerankEnabled ? rerankScore(prompt, chunk, hybrid, queryTokens) : hybrid;
    return {
      indexed: chunk,
      hybridScore: hybrid,
      rerankScore: rerank,
      lexicalScore: lexical,
      denseScore: dense,
      recencyScore: recency,
    } satisfies RetrievalCandidate;
  });

  if (env.ragRerankEnabled && ranked.length > 0) {
    try {
      const remoteScores = await requestRemoteRerank(prompt, ranked);
      if (remoteScores && remoteScores.size > 0) {
        for (const item of ranked) {
          const remote = remoteScores.get(item.indexed.id);
          if (remote == null) {
            continue;
          }
          item.rerankScore = clamp(remote * 0.7 + item.rerankScore * 0.3, 0, 1.6);
        }
      }
    } catch {
      // keep heuristic rerank when remote rerank is unavailable
    }
  }

  const baseline = ranked
    .filter((item) => item.hybridScore >= options.minScore)
    .sort((left, right) => right.hybridScore - left.hybridScore || right.recencyScore - left.recencyScore)
    .slice(0, options.candidateLimit);

  const reranked = ranked
    .filter((item) => item.rerankScore >= options.minScore)
    .sort((left, right) => right.rerankScore - left.rerankScore || right.recencyScore - left.recencyScore)
    .slice(0, options.candidateLimit);

  const mmr = applyMmrSelection(reranked, options.limit, clamp(env.ragMmrLambda ?? 0.72, 0.2, 0.95));
  return {
    baseline,
    reranked: mmr,
  };
}

async function retrieveKnowledgeDebug(prompt: string, options: KnowledgeQueryOptions = {}): Promise<RetrievalDebugBundle> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return {
      final: [],
      baseline: [],
    };
  }

  const adaptiveEnabled = env.ragAdaptiveRetrieveEnabled;
  if (!options.forceRetrieve && adaptiveEnabled && shouldSkipRetrieval(trimmedPrompt) && !shouldForceRetrieval(trimmedPrompt)) {
    return {
      final: [],
      baseline: [],
    };
  }

  await ensureKnowledgeIndex();
  const queryTokens = tokenize(trimmedPrompt);
  if (queryTokens.length === 0) {
    return {
      final: [],
      baseline: [],
    };
  }

  const queryTf = termFrequency(queryTokens);
  const merged = mergeOptions(trimmedPrompt, options);
  const filtered = applyMetadataFilters(cache.chunks, merged);
  const hasStrictFilters =
    merged.moduleIds.length > 0 ||
    merged.sourceTypes.length > 0 ||
    merged.docIds.length > 0 ||
    merged.scope !== 'all' ||
    Boolean(merged.userId) ||
    Boolean(merged.tenantId) ||
    Boolean(merged.sessionId) ||
    Number.isFinite(merged.fromTs) ||
    Number.isFinite(merged.toTs);
  const pool = filtered.length >= 2 || hasStrictFilters ? filtered : cache.chunks;
  if (pool.length === 0) {
    return {
      final: [],
      baseline: [],
    };
  }

  const scoreMaps = await buildRetrievalScores(trimmedPrompt, queryTf, pool, merged);
  const candidates = pickCandidates(pool, scoreMaps.dense, scoreMaps.lexical, merged.candidateLimit);
  const ranked = await rankCandidates(trimmedPrompt, new Set(queryTokens), candidates, scoreMaps, merged);

  return {
    final: ranked.reranked.map(toRetrievedChunk),
    baseline: ranked.baseline.slice(0, merged.limit).map((item) => {
      const chunk = toRetrievedChunk(item);
      return {
        ...chunk,
        score: item.hybridScore,
      };
    }),
  };
}

export async function retrieveKnowledge(prompt: string, options: KnowledgeQueryOptions = {}) {
  const debug = await retrieveKnowledgeDebug(prompt, options);
  const memoryIds = debug.final.filter((chunk) => chunk.sourceType === 'memory').map((chunk) => chunk.id);
  touchMemoryRecords(memoryIds);
  return debug.final;
}

export function buildKnowledgeContext(chunks: RetrievedKnowledgeChunk[]) {
  if (chunks.length === 0) {
    return 'No relevant knowledge snippets were retrieved.';
  }

  return chunks
    .map((chunk, index) => {
      return [
        `[${index + 1}] Document: ${chunk.docTitle}`,
        `Section: ${chunk.sectionTitle}`,
        `Citation: ${chunk.citation}`,
        `Score: ${chunk.score.toFixed(3)} (dense: ${chunk.denseScore.toFixed(3)}, lexical: ${chunk.lexicalScore.toFixed(3)}, recency: ${chunk.recencyScore.toFixed(3)})`,
        `Content: ${chunk.content}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function getKnowledgeStats(): KnowledgeStats {
  return {
    sourceCount: SOURCE_DEFINITIONS.length,
    chunkCount: cache.chunks.length,
    sources: SOURCE_DEFINITIONS.map((source) => source.fileName),
    retrievalMode: parseRetrievalMode(env.ragRetrievalMode),
    scope: parseScope(env.ragScopeDefault),
    lancedb: lanceState,
    rerankProvider: getRerankProvider(),
    adaptiveRetrieval: env.ragAdaptiveRetrieveEnabled,
  };
}

export function getKnowledgeDiagnostics(): KnowledgeDiagnostics {
  const memoryRecords = readMemoryRecords();
  const manifest = readManifest();
  const manifestSignatures = manifest?.sourceSignatures ?? {};
  const sources: KnowledgeSourceDiagnostic[] = SOURCE_DEFINITIONS.map((source) => {
    const absolutePath = getSourceFilePath(source.fileName);
    const exists = fs.existsSync(absolutePath);
    const stats = exists ? fs.statSync(absolutePath) : null;
    const currentSignature = buildSourceSignature(source);
    const manifestSignature = manifestSignatures[source.docId] ?? '';
    const inManifest = Boolean(manifestSignature);

    return {
      docId: source.docId,
      fileName: source.fileName,
      absolutePath,
      sourceType: source.sourceType,
      moduleId: source.moduleId,
      scopeType: source.scopeType,
      exists,
      size: stats?.size ?? 0,
      updatedAt: stats ? stats.mtime.toISOString() : '',
      currentSignature,
      manifestSignature,
      inManifest,
      signatureChanged: inManifest && manifestSignature !== currentSignature,
    };
  });

  const missingSources = sources.filter((item) => !item.exists).map((item) => item.fileName);
  const changedSinceManifest = sources.filter((item) => item.signatureChanged).map((item) => item.docId);
  const byTier: Record<MemoryTier, number> = {
    working: 0,
    episodic: 0,
    semantic: 0,
    archive: 0,
  };
  const perUserCounter = new Map<string, number>();
  for (const item of memoryRecords) {
    byTier[item.tier] += 1;
    perUserCounter.set(item.userId, (perUserCounter.get(item.userId) ?? 0) + 1);
  }
  const perUserTop = Array.from(perUserCounter.entries())
    .map(([userId, count]) => ({ userId, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    manifestPath: getManifestPath(),
    manifestExists: Boolean(manifest),
    manifest,
    cacheSignature: cache.signature,
    cacheRefreshedAt: cache.refreshedAt,
    sourceCount: sources.length,
    sourcePresentCount: sources.length - missingSources.length,
    missingSources,
    changedSinceManifest,
    sources,
    memory: {
      total: memoryRecords.length,
      byTier,
      perUserTop,
      maxPerUser: Math.max(50, toPositiveNumber(env.ragMemoryMaxPerUser, 600)),
      maxGlobal: Math.max(50, toPositiveNumber(env.ragMemoryMaxGlobal, 12000)),
    },
    lancedb: lanceState,
  };
}

export async function rebuildKnowledgeIndex(options: RebuildKnowledgeIndexOptions = {}): Promise<RebuildKnowledgeIndexResult> {
  const refreshed = await ensureKnowledgeIndex({
    force: options.force ?? false,
    incremental: options.incremental ?? true,
  });

  return {
    chunkCount: refreshed.chunks.length,
    sourceCount: SOURCE_DEFINITIONS.length,
    changedDocIds: lanceState.changedDocIds,
    removedDocIds: lanceState.removedDocIds,
    lancedbEnabled: lanceState.enabled,
    lancedbAvailable: lanceState.available,
    lancedbIndexedRows: lanceState.indexedRows,
    lancedbError: lanceState.lastError,
    signature: refreshed.signature,
    refreshedAt: refreshed.refreshedAt,
  };
}

interface ParsedEvalCase {
  id: string;
  query: string;
  moduleIds?: string[];
  sourceTypes?: SourceType[];
  docIds?: string[];
  expectedDocIds: string[];
  expectedCitations: string[];
  expectedKeywords: string[];
}

function parseEvalCases(datasetPath: string): ParsedEvalCase[] {
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`dataset not found: ${datasetPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf8')) as EvalCase[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('dataset must be a non-empty array');
  }

  return raw
    .map((item): ParsedEvalCase | null => {
      const query = typeof item.query === 'string' ? item.query.trim() : '';
      if (!query) {
        return null;
      }

      return {
        id: typeof item.id === 'string' ? item.id : query.slice(0, 24),
        query,
        moduleIds: Array.isArray(item.moduleIds) ? item.moduleIds : undefined,
        sourceTypes: Array.isArray(item.sourceTypes)
          ? item.sourceTypes.map((sourceType) => parseSourceType(sourceType)).filter((sourceType): sourceType is SourceType => sourceType != null)
          : undefined,
        docIds: Array.isArray(item.docIds) ? item.docIds : undefined,
        expectedDocIds: Array.isArray(item.expectedDocIds) ? item.expectedDocIds : [],
        expectedCitations: Array.isArray(item.expectedCitations) ? item.expectedCitations : [],
        expectedKeywords: Array.isArray(item.expectedKeywords) ? item.expectedKeywords : [],
      };
    })
    .filter((item): item is ParsedEvalCase => item != null);
}

function matchExpected(chunk: RetrievedKnowledgeChunk, item: { expectedDocIds: string[]; expectedCitations: string[]; expectedKeywords: string[] }) {
  if (item.expectedDocIds.length > 0 && item.expectedDocIds.includes(chunk.docId)) {
    return true;
  }
  if (item.expectedCitations.length > 0 && item.expectedCitations.some((citation) => chunk.citation.includes(citation))) {
    return true;
  }
  if (
    item.expectedKeywords.length > 0 &&
    item.expectedKeywords.some((keyword) => chunk.content.includes(keyword) || chunk.sectionTitle.includes(keyword))
  ) {
    return true;
  }
  return false;
}

function reciprocalRank(chunks: RetrievedKnowledgeChunk[], expect: { expectedDocIds: string[]; expectedCitations: string[]; expectedKeywords: string[] }) {
  for (let index = 0; index < chunks.length; index += 1) {
    if (matchExpected(chunks[index], expect)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

function hitAtK(chunks: RetrievedKnowledgeChunk[], expect: { expectedDocIds: string[]; expectedCitations: string[]; expectedKeywords: string[] }) {
  return chunks.some((chunk) => matchExpected(chunk, expect)) ? 1 : 0;
}

export async function evaluateKnowledgeRetrieval(options: EvaluateKnowledgeOptions): Promise<EvaluateKnowledgeResult> {
  const k = Math.max(1, Math.min(10, options.k ?? 3));
  const cases = parseEvalCases(options.datasetPath);
  if (cases.length === 0) {
    throw new Error('dataset has no valid cases');
  }

  await ensureKnowledgeIndex({ force: false, incremental: true });

  let hitBaseline = 0;
  let hitRerank = 0;
  let mrrBaseline = 0;
  let mrrRerank = 0;
  const failedCases: EvaluateKnowledgeResult['failedCases'] = [];

  for (const item of cases) {
    const debug = await retrieveKnowledgeDebug(item.query, {
      limit: k,
      candidateLimit: Math.max(k + 6, env.ragCandidateK ?? 18),
      moduleIds: item.moduleIds,
      sourceTypes: item.sourceTypes,
      docIds: item.docIds,
    });
    const baselineTop = debug.baseline.slice(0, k);
    const rerankedTop = debug.final.slice(0, k);
    const expect = {
      expectedDocIds: item.expectedDocIds,
      expectedCitations: item.expectedCitations,
      expectedKeywords: item.expectedKeywords,
    };

    const baselineHit = hitAtK(baselineTop, expect);
    const rerankHit = hitAtK(rerankedTop, expect);
    hitBaseline += baselineHit;
    hitRerank += rerankHit;

    const rrBaseline = reciprocalRank(baselineTop, expect);
    const rrRerank = reciprocalRank(rerankedTop, expect);
    mrrBaseline += rrBaseline;
    mrrRerank += rrRerank;

    if (!rerankHit) {
      failedCases.push({
        id: item.id,
        query: item.query,
        expected: JSON.stringify(expect),
        baselineTop: baselineTop.map((chunk) => chunk.citation),
        rerankedTop: rerankedTop.map((chunk) => chunk.citation),
      });
    }
  }

  const total = cases.length;
  return {
    total,
    k,
    hitRateBaseline: hitBaseline / total,
    hitRateReranked: hitRerank / total,
    mrrBaseline: mrrBaseline / total,
    mrrReranked: mrrRerank / total,
    rerankGain: mrrRerank / total - mrrBaseline / total,
    failedCases: failedCases.slice(0, 20),
  };
}
