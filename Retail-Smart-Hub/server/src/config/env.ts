import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

const AGENT_SHARED_KEY_FILE_NAME = 'agent-shared-key.txt';

function loadEnvFile() {
  const candidates = [
    process.env.RETAIL_SMART_HUB_ENV_DIR,
    process.cwd(),
    path.dirname(process.execPath),
  ].filter(Boolean) as string[];

  for (const baseDir of candidates) {
    const envPath = path.resolve(baseDir, '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return envPath;
    }
  }

  dotenv.config();
  return '';
}

loadEnvFile();

function resolveDataRootDir() {
  const configuredRoot = process.env.RETAIL_SMART_HUB_DATA_DIR?.trim();
  return configuredRoot ? path.resolve(configuredRoot) : path.resolve(process.cwd(), 'database');
}

function readFileTrimmed(filePath: string) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const value = raw.trim();
    return value || '';
  } catch {
    return '';
  }
}

function ensureAgentSharedKey() {
  const fromEnv = process.env.AI_AGENT_SHARED_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const dataRoot = resolveDataRootDir();
  fs.mkdirSync(dataRoot, { recursive: true });
  const keyPath = path.join(dataRoot, AGENT_SHARED_KEY_FILE_NAME);
  const existing = readFileTrimmed(keyPath);
  if (existing) {
    process.env.AI_AGENT_SHARED_KEY = existing;
    return existing;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, `${generated}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const nowExisting = readFileTrimmed(keyPath);
    if (nowExisting) {
      process.env.AI_AGENT_SHARED_KEY = nowExisting;
      return nowExisting;
    }
    throw error;
  }

  process.env.AI_AGENT_SHARED_KEY = generated;
  return generated;
}

function toNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseCsv(value: string | undefined, fallback: string[]) {
  const raw = (value || '').trim();
  if (!raw) {
    return fallback;
  }

  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeNodeEnv(value: string | undefined) {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'production' || normalized === 'test' || normalized === 'development') {
    return normalized;
  }
  return 'development';
}

function normalizeAiProvider(value: string | undefined) {
  const normalized = (value || 'deepseek').trim().toLowerCase();
  if (normalized === 'openai') {
    return 'openai';
  }
  if (normalized === 'gemini') {
    return 'gemini';
  }
  return 'deepseek';
}

function resolveActiveAiModel(provider: string, deepseekModel: string, openaiModel: string, geminiModel: string) {
  if (provider === 'openai') {
    return openaiModel;
  }
  if (provider === 'gemini') {
    return geminiModel;
  }
  return deepseekModel;
}

function resolveActiveAiApiKey(provider: string, deepseekApiKey: string, openaiApiKey: string, geminiApiKey: string) {
  if (provider === 'openai') {
    return openaiApiKey;
  }
  if (provider === 'gemini') {
    return geminiApiKey;
  }
  return deepseekApiKey;
}

function resolveActiveAiApiKeyEnv(provider: string) {
  if (provider === 'openai') {
    return 'OPENAI_API_KEY';
  }
  if (provider === 'gemini') {
    return 'GEMINI_API_KEY';
  }
  return 'DEEPSEEK_API_KEY';
}

function resolveProviderValue(provider: string, deepseekValue: string, openaiValue: string, geminiValue: string) {
  if (provider === 'openai') {
    return openaiValue;
  }
  if (provider === 'gemini') {
    return geminiValue;
  }
  return deepseekValue;
}

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openaiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiBaseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const tavilyApiKey = process.env.TAVILY_API_KEY || '';
const tavilyBaseUrl = process.env.TAVILY_BASE_URL || 'https://api.tavily.com';
const tavilyTopic = (process.env.TAVILY_TOPIC || 'general').trim().toLowerCase() === 'news' ? 'news' : 'general';
const tavilyMaxResults = Math.max(1, Math.min(8, toNumber(process.env.TAVILY_MAX_RESULTS, 5)));
const aiAgentSharedKey = ensureAgentSharedKey();
const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV);

const aiProvider = normalizeAiProvider(process.env.AI_PROVIDER);
const aiSmallProvider = normalizeAiProvider(process.env.AI_SMALL_PROVIDER || process.env.AI_PROVIDER);
const aiLargeProvider = normalizeAiProvider(process.env.AI_LARGE_PROVIDER || process.env.AI_PROVIDER);

const aiSmallApiKey = (
  process.env.AI_SMALL_API_KEY || resolveProviderValue(aiSmallProvider, deepseekApiKey, openaiApiKey, geminiApiKey)
).trim();
const aiSmallModel = (
  process.env.AI_SMALL_MODEL || resolveProviderValue(aiSmallProvider, deepseekModel, openaiModel, geminiModel)
).trim();
const aiSmallBaseUrl = (
  process.env.AI_SMALL_BASE_URL || resolveProviderValue(aiSmallProvider, deepseekBaseUrl, openaiBaseUrl, geminiBaseUrl)
).trim();
const aiLargeApiKey = (
  process.env.AI_LARGE_API_KEY || resolveProviderValue(aiLargeProvider, deepseekApiKey, openaiApiKey, geminiApiKey)
).trim();
const aiLargeModel = (
  process.env.AI_LARGE_MODEL || resolveProviderValue(aiLargeProvider, deepseekModel, openaiModel, geminiModel)
).trim();
const aiLargeBaseUrl = (
  process.env.AI_LARGE_BASE_URL || resolveProviderValue(aiLargeProvider, deepseekBaseUrl, openaiBaseUrl, geminiBaseUrl)
).trim();

export const env = {
  port: toNumber(process.env.API_PORT, 4000),
  host: process.env.API_HOST?.trim() || '127.0.0.1',
  nodeEnv,
  corsOrigins: parseCsv(process.env.CORS_ORIGINS, ['http://127.0.0.1:3000', 'http://localhost:3000']),
  corsAllowNullOrigin: toBoolean(process.env.CORS_ALLOW_NULL_ORIGIN, false),
  aiProvider,
  aiSmallProvider,
  aiLargeProvider,
  aiRuntime: (process.env.AI_RUNTIME || 'python').trim().toLowerCase(),
  aiLayeredAgentEnabled: toBoolean(process.env.AI_LAYERED_AGENT_ENABLED, true),
  aiPythonHost: process.env.AI_PYTHON_HOST?.trim() || '127.0.0.1',
  aiPythonPort: toNumber(process.env.AI_PYTHON_PORT, 18080),
  aiPythonCommand: process.env.AI_PYTHON_COMMAND?.trim() || 'python',
  aiPythonEntry: process.env.AI_PYTHON_ENTRY?.trim() || '',
  aiPythonAutostart: toBoolean(process.env.AI_PYTHON_AUTOSTART, true),
  aiAgentSharedKey,
  aiAgentRequestTimeoutMs: toNumber(process.env.AI_AGENT_REQUEST_TIMEOUT_MS, 120000),
  authDebugExposeResetToken: toBoolean(process.env.AUTH_DEBUG_EXPOSE_RESET_TOKEN, nodeEnv !== 'production'),
  authDebugLogSeedPasswords: toBoolean(process.env.AUTH_DEBUG_LOG_SEED_PASSWORDS, false),
  deepseekApiKey,
  deepseekModel,
  deepseekBaseUrl,
  openaiApiKey,
  openaiModel,
  openaiBaseUrl,
  geminiApiKey,
  geminiModel,
  geminiBaseUrl,
  tavilyApiKey,
  tavilyBaseUrl,
  tavilyTopic,
  tavilyMaxResults,
  aiSmallApiKey,
  aiSmallModel,
  aiSmallBaseUrl,
  aiLargeApiKey,
  aiLargeModel,
  aiLargeBaseUrl,
  aiMockFallback: toBoolean(process.env.AI_MOCK_FALLBACK, false),
  ragRetrievalMode: process.env.RAG_RETRIEVAL_MODE || 'hybrid',
  ragScopeDefault: process.env.RAG_SCOPE_DEFAULT || 'all',
  ragTopK: toNumber(process.env.RAG_TOP_K, 3),
  ragCandidateK: toNumber(process.env.RAG_CANDIDATE_K, 18),
  ragMinScore: toNumber(process.env.RAG_MIN_SCORE, 0.18),
  ragDenseWeight: toNumber(process.env.RAG_DENSE_WEIGHT, 0.42),
  ragLexicalWeight: toNumber(process.env.RAG_LEXICAL_WEIGHT, 0.48),
  ragMmrLambda: toNumber(process.env.RAG_MMR_LAMBDA, 0.72),
  ragRecencyHalfLifeDays: toNumber(process.env.RAG_RECENCY_HALF_LIFE_DAYS, 45),
  ragLancedbEnabled: toBoolean(process.env.RAG_LANCEDB_ENABLED, true),
  ragLancedbDir: process.env.RAG_LANCEDB_DIR || path.resolve(process.cwd(), 'database', 'rag', 'lancedb'),
  ragLancedbTable: process.env.RAG_LANCEDB_TABLE || 'knowledge_chunks',
  ragEmbeddingProvider: process.env.RAG_EMBEDDING_PROVIDER || 'openai',
  ragEmbeddingBaseUrl: process.env.RAG_EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
  ragEmbeddingApiKey: process.env.RAG_EMBEDDING_API_KEY || '',
  ragEmbeddingModel: process.env.RAG_EMBEDDING_MODEL || '',
  ragEmbeddingBatchSize: toNumber(process.env.RAG_EMBEDDING_BATCH_SIZE, 24),
  ragEmbeddingDimensions: toNumber(process.env.RAG_EMBEDDING_DIMENSIONS, 0),
  ragVectorCandidateK: toNumber(process.env.RAG_VECTOR_CANDIDATE_K, 32),
  ragFtsCandidateK: toNumber(process.env.RAG_FTS_CANDIDATE_K, 32),
  ragRerankEnabled: toBoolean(process.env.RAG_RERANK_ENABLED, true),
  ragRerankProvider: process.env.RAG_RERANK_PROVIDER || 'heuristic',
  ragRerankBaseUrl: process.env.RAG_RERANK_BASE_URL || '',
  ragRerankApiKey: process.env.RAG_RERANK_API_KEY || '',
  ragRerankModel: process.env.RAG_RERANK_MODEL || '',
  ragRerankTopN: toNumber(process.env.RAG_RERANK_TOP_N, 20),
  ragAdaptiveRetrieveEnabled: toBoolean(process.env.RAG_ADAPTIVE_RETRIEVE_ENABLED, true),
  ragMemoryEnabled: toBoolean(process.env.RAG_MEMORY_ENABLED, true),
  ragMemoryRetentionDays: toNumber(process.env.RAG_MEMORY_RETENTION_DAYS, 60),
  ragMemoryWorkingDays: toNumber(process.env.RAG_MEMORY_WORKING_DAYS, 14),
  ragMemoryEpisodicDays: toNumber(process.env.RAG_MEMORY_EPISODIC_DAYS, 90),
  ragMemorySemanticDays: toNumber(process.env.RAG_MEMORY_SEMANTIC_DAYS, 365),
  ragMemoryDecayHalfLifeDays: toNumber(process.env.RAG_MEMORY_DECAY_HALF_LIFE_DAYS, 120),
  ragMemoryMaxPerUser: toNumber(process.env.RAG_MEMORY_MAX_PER_USER, 600),
  ragMemoryMaxGlobal: toNumber(process.env.RAG_MEMORY_MAX_GLOBAL, 12000),
  ragMemoryPromotionReinforce: toNumber(process.env.RAG_MEMORY_PROMOTION_REINFORCE, 2),
  ragMemoryPromotionImportance: toNumber(process.env.RAG_MEMORY_PROMOTION_IMPORTANCE, 0.62),
  ragMemorySemanticReinforce: toNumber(process.env.RAG_MEMORY_SEMANTIC_REINFORCE, 5),
  ragMemorySemanticImportance: toNumber(process.env.RAG_MEMORY_SEMANTIC_IMPORTANCE, 0.82),
};

export function isAiConfigured() {
  const activeKey =
    env.aiLargeApiKey ||
    resolveActiveAiApiKey(env.aiLargeProvider, env.deepseekApiKey, env.openaiApiKey, env.geminiApiKey);
  return Boolean(activeKey) && !activeKey.startsWith('REPLACE_WITH_');
}

export function getActiveAiModel() {
  return env.aiLargeModel || resolveActiveAiModel(env.aiLargeProvider, env.deepseekModel, env.openaiModel, env.geminiModel);
}

export function getActiveAiApiKeyEnv() {
  return env.aiLargeApiKey ? 'AI_LARGE_API_KEY' : resolveActiveAiApiKeyEnv(env.aiLargeProvider);
}
