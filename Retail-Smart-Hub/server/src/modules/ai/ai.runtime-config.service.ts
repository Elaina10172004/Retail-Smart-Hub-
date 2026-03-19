import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';

type AiProvider = 'deepseek' | 'openai' | 'gemini';
type TavilyTopic = 'general' | 'news';

interface PersistedAiRuntimeConfig {
  provider?: AiProvider;
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  deepseekModel?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  geminiModel?: string;
  tavilyApiKey?: string;
  tavilyBaseUrl?: string;
  tavilyTopic?: TavilyTopic;
  tavilyMaxResults?: number;
  smallProvider?: AiProvider;
  smallApiKey?: string;
  smallBaseUrl?: string;
  smallModel?: string;
  largeProvider?: AiProvider;
  largeApiKey?: string;
  largeBaseUrl?: string;
  largeModel?: string;
  layeredAgentEnabled?: boolean;
  updatedAt?: string;
}

export interface AiModelProfileSnapshot {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

export interface TavilyRuntimeProfileSnapshot {
  provider: 'tavily';
  baseUrl: string;
  topic: TavilyTopic;
  maxResults: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
  enabled: boolean;
}

export interface AiRuntimeConfigSnapshot {
  provider: AiProvider;
  runtime: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  geminiBaseUrl: string;
  geminiModel: string;
  tavilyBaseUrl: string;
  tavilyTopic: TavilyTopic;
  tavilyMaxResults: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
  deepseekHasApiKey: boolean;
  deepseekApiKeyMasked: string;
  openaiHasApiKey: boolean;
  openaiApiKeyMasked: string;
  geminiHasApiKey: boolean;
  geminiApiKeyMasked: string;
  tavilyHasApiKey: boolean;
  tavilyApiKeyMasked: string;
  activeModel: string;
  providerProfiles: Record<AiProvider, AiModelProfileSnapshot>;
  smallRoleProvider: AiProvider;
  largeRoleProvider: AiProvider;
  smallModelProfile: AiModelProfileSnapshot;
  largeModelProfile: AiModelProfileSnapshot;
  tavilyProfile: TavilyRuntimeProfileSnapshot;
  layeredAgentEnabled: boolean;
  updatedAt?: string;
}

export interface AiRuntimeConfigPatchInput {
  provider?: AiProvider;
  deepseekApiKey?: string | null;
  deepseekBaseUrl?: string;
  deepseekModel?: string;
  openaiApiKey?: string | null;
  openaiBaseUrl?: string;
  openaiModel?: string;
  geminiApiKey?: string | null;
  geminiBaseUrl?: string;
  geminiModel?: string;
  tavilyApiKey?: string | null;
  tavilyBaseUrl?: string;
  tavilyTopic?: TavilyTopic;
  tavilyMaxResults?: number;
  smallProvider?: AiProvider;
  smallApiKey?: string | null;
  smallBaseUrl?: string;
  smallModel?: string;
  largeProvider?: AiProvider;
  largeApiKey?: string | null;
  largeBaseUrl?: string;
  largeModel?: string;
  layeredAgentEnabled?: boolean;
}

const runtimeConfigPath = resolveRuntimeConfigPath();
const runtimeConfigKeyPath = path.join(path.dirname(runtimeConfigPath), 'ai-runtime-config.key');

const SECRET_PREFIX = 'enc:v1:';
let cachedRuntimeConfigKey: Buffer | null = null;

function loadOrCreateRuntimeConfigKey() {
  if (cachedRuntimeConfigKey) {
    return cachedRuntimeConfigKey;
  }

  try {
    if (fs.existsSync(runtimeConfigKeyPath)) {
      const raw = fs.readFileSync(runtimeConfigKeyPath, 'utf8').trim();
      const decoded = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
      if (decoded.length === 32) {
        cachedRuntimeConfigKey = decoded;
        return decoded;
      }
    }
  } catch {
    // fall through to regenerate
  }

  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(runtimeConfigKeyPath, key.toString('base64'), 'utf8');
  } catch {
    // If the key cannot be persisted, we still return a process-local key.
    // This prevents plaintext persistence, but secrets will not survive restarts.
  }
  cachedRuntimeConfigKey = key;
  return key;
}

function isEncryptedSecret(value: string) {
  return value.startsWith(SECRET_PREFIX) && value.length > SECRET_PREFIX.length;
}

function encryptSecret(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  const key = loadOrCreateRuntimeConfigKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  return `${SECRET_PREFIX}${packed}`;
}

function tryDecryptSecret(value: string) {
  if (!isEncryptedSecret(value)) {
    return null;
  }
  const payload = value.slice(SECRET_PREFIX.length).trim();
  if (!payload) {
    return '';
  }

  try {
    const raw = Buffer.from(payload, 'base64');
    if (raw.length < 12 + 16 + 1) {
      return null;
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const key = loadOrCreateRuntimeConfigKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return plaintext.trim();
  } catch {
    return null;
  }
}

function readOptionalSecretString(value: unknown) {
  if (typeof value !== 'string') {
    return { value: undefined as string | undefined, needsRewrite: false };
  }
  const normalized = value.trim();
  if (normalized === '') {
    // explicit empty string = cleared secret (not sensitive)
    return { value: '', needsRewrite: false };
  }
  if (isEncryptedSecret(normalized)) {
    const decrypted = tryDecryptSecret(normalized);
    if (decrypted === null) {
      return { value: undefined, needsRewrite: false };
    }
    return { value: decrypted, needsRewrite: false };
  }
  // Legacy plaintext secret.
  return { value: normalized, needsRewrite: true };
}

function resolveRuntimeConfigPath() {
  const configuredRoot = process.env.RETAIL_SMART_HUB_DATA_DIR?.trim();
  const dataRoot = configuredRoot ? path.resolve(configuredRoot) : path.resolve(process.cwd(), 'database');
  fs.mkdirSync(dataRoot, { recursive: true });
  return path.join(dataRoot, 'ai-runtime-config.json');
}

function maskApiKey(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 8) {
    return '*'.repeat(normalized.length);
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

function normalizeProvider(value: unknown): AiProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'openai') {
    return 'openai';
  }
  if (normalized === 'gemini') {
    return 'gemini';
  }
  return 'deepseek';
}

function normalizeTavilyTopic(value: unknown): TavilyTopic {
  return typeof value === 'string' && value.trim().toLowerCase() === 'news' ? 'news' : 'general';
}

function clampTavilyMaxResults(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  return Math.max(1, Math.min(8, Math.trunc(parsed)));
}

function readOptionalProvider(value: unknown): AiProvider | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return normalizeProvider(value);
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveProviderBaseUrl(provider: AiProvider) {
  if (provider === 'openai') {
    return env.openaiBaseUrl;
  }
  if (provider === 'gemini') {
    return env.geminiBaseUrl;
  }
  return env.deepseekBaseUrl;
}

function resolveProviderModel(provider: AiProvider) {
  if (provider === 'openai') {
    return env.openaiModel;
  }
  if (provider === 'gemini') {
    return env.geminiModel;
  }
  return env.deepseekModel;
}

function resolveProviderApiKey(provider: AiProvider) {
  if (provider === 'openai') {
    return env.openaiApiKey;
  }
  if (provider === 'gemini') {
    return env.geminiApiKey;
  }
  return env.deepseekApiKey;
}

function resolveProviderProfile(provider: AiProvider): AiModelProfileSnapshot {
  const baseUrl = resolveProviderBaseUrl(provider).trim();
  const model = resolveProviderModel(provider).trim();
  const apiKey = resolveProviderApiKey(provider).trim();
  return {
    provider,
    baseUrl,
    model,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskApiKey(apiKey),
  };
}

function resolveRoleProfile(role: 'small' | 'large'): AiModelProfileSnapshot {
  const provider = role === 'small' ? normalizeProvider(env.aiSmallProvider) : normalizeProvider(env.aiLargeProvider);
  const baseUrlRaw = role === 'small' ? env.aiSmallBaseUrl : env.aiLargeBaseUrl;
  const modelRaw = role === 'small' ? env.aiSmallModel : env.aiLargeModel;
  const apiKeyRaw = role === 'small' ? env.aiSmallApiKey : env.aiLargeApiKey;
  const providerProfile = resolveProviderProfile(provider);
  const baseUrl = baseUrlRaw.trim() || providerProfile.baseUrl;
  const model = modelRaw.trim() || providerProfile.model;
  const apiKey = apiKeyRaw.trim() || resolveProviderApiKey(provider).trim();

  return {
    provider,
    baseUrl,
    model,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskApiKey(apiKey),
  };
}

function resolveTavilyProfile(): TavilyRuntimeProfileSnapshot {
  const apiKey = env.tavilyApiKey.trim();
  return {
    provider: 'tavily',
    baseUrl: env.tavilyBaseUrl.trim(),
    topic: normalizeTavilyTopic(env.tavilyTopic),
    maxResults: clampTavilyMaxResults(env.tavilyMaxResults),
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskApiKey(apiKey),
    enabled: Boolean(apiKey),
  };
}

function resolvePersistedProviderField(
  provider: AiProvider | undefined,
  field: 'apiKey' | 'baseUrl' | 'model',
  values: {
    deepseekApiKey?: string;
    deepseekBaseUrl?: string;
    deepseekModel?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    openaiModel?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    geminiModel?: string;
  },
) {
  if (provider === 'openai') {
    return field === 'apiKey'
      ? values.openaiApiKey
      : field === 'baseUrl'
        ? values.openaiBaseUrl
        : values.openaiModel;
  }
  if (provider === 'gemini') {
    return field === 'apiKey'
      ? values.geminiApiKey
      : field === 'baseUrl'
        ? values.geminiBaseUrl
        : values.geminiModel;
  }
  return field === 'apiKey'
    ? values.deepseekApiKey
    : field === 'baseUrl'
      ? values.deepseekBaseUrl
      : values.deepseekModel;
}

function readPersistedConfig(): PersistedAiRuntimeConfig {
  if (!fs.existsSync(runtimeConfigPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(runtimeConfigPath, 'utf8');
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw) as PersistedAiRuntimeConfig;
    const provider = readOptionalProvider(parsed.provider);
    const deepseekApiKeyRead = readOptionalSecretString(parsed.deepseekApiKey);
    const deepseekApiKey = deepseekApiKeyRead.value;
    const deepseekBaseUrl = readOptionalString(parsed.deepseekBaseUrl);
    const deepseekModel = readOptionalString(parsed.deepseekModel);
    const openaiApiKeyRead = readOptionalSecretString(parsed.openaiApiKey);
    const openaiApiKey = openaiApiKeyRead.value;
    const openaiBaseUrl = readOptionalString(parsed.openaiBaseUrl);
    const openaiModel = readOptionalString(parsed.openaiModel);
    const geminiApiKeyRead = readOptionalSecretString(parsed.geminiApiKey);
    const geminiApiKey = geminiApiKeyRead.value;
    const geminiBaseUrl = readOptionalString(parsed.geminiBaseUrl);
    const geminiModel = readOptionalString(parsed.geminiModel);
    const smallProvider = readOptionalProvider(parsed.smallProvider) || provider;
    const largeProvider = readOptionalProvider(parsed.largeProvider) || provider;
    const layeredAgentEnabled = readOptionalBoolean(parsed.layeredAgentEnabled);
    const tavilyApiKeyRead = readOptionalSecretString(parsed.tavilyApiKey);

    const needsRewrite =
      deepseekApiKeyRead.needsRewrite ||
      openaiApiKeyRead.needsRewrite ||
      geminiApiKeyRead.needsRewrite ||
      tavilyApiKeyRead.needsRewrite ||
      (typeof parsed.smallApiKey === 'string' && readOptionalSecretString(parsed.smallApiKey).needsRewrite) ||
      (typeof parsed.largeApiKey === 'string' && readOptionalSecretString(parsed.largeApiKey).needsRewrite);

    const resolved: PersistedAiRuntimeConfig = {
      provider,
      deepseekApiKey,
      deepseekBaseUrl,
      deepseekModel,
      openaiApiKey,
      openaiBaseUrl,
      openaiModel,
      geminiApiKey,
      geminiBaseUrl,
      geminiModel,
      tavilyApiKey: tavilyApiKeyRead.value,
      tavilyBaseUrl: readOptionalString(parsed.tavilyBaseUrl),
      tavilyTopic: parsed.tavilyTopic ? normalizeTavilyTopic(parsed.tavilyTopic) : undefined,
      tavilyMaxResults: readOptionalNumber(parsed.tavilyMaxResults),
      smallProvider,
      smallApiKey:
        typeof parsed.smallApiKey === 'string'
          ? readOptionalSecretString(parsed.smallApiKey).value
          : resolvePersistedProviderField(smallProvider, 'apiKey', {
              deepseekApiKey,
              deepseekBaseUrl,
              deepseekModel,
              openaiApiKey,
              openaiBaseUrl,
              openaiModel,
              geminiApiKey,
              geminiBaseUrl,
              geminiModel,
            }),
      smallBaseUrl:
        typeof parsed.smallBaseUrl === 'string'
          ? parsed.smallBaseUrl
          : resolvePersistedProviderField(smallProvider, 'baseUrl', {
              deepseekApiKey,
              deepseekBaseUrl,
              deepseekModel,
              openaiApiKey,
              openaiBaseUrl,
              openaiModel,
              geminiApiKey,
              geminiBaseUrl,
              geminiModel,
            }),
      smallModel:
        typeof parsed.smallModel === 'string'
          ? parsed.smallModel
          : resolvePersistedProviderField(smallProvider, 'model', {
              deepseekApiKey,
              deepseekBaseUrl,
              deepseekModel,
              openaiApiKey,
              openaiBaseUrl,
              openaiModel,
              geminiApiKey,
              geminiBaseUrl,
              geminiModel,
            }),
      largeProvider,
      largeApiKey:
        typeof parsed.largeApiKey === 'string'
          ? readOptionalSecretString(parsed.largeApiKey).value
          : resolvePersistedProviderField(largeProvider, 'apiKey', {
              deepseekApiKey,
              deepseekBaseUrl,
              deepseekModel,
              openaiApiKey,
              openaiBaseUrl,
              openaiModel,
              geminiApiKey,
              geminiBaseUrl,
              geminiModel,
            }),
      largeBaseUrl:
        typeof parsed.largeBaseUrl === 'string'
          ? parsed.largeBaseUrl
          : resolvePersistedProviderField(largeProvider, 'baseUrl', {
              deepseekApiKey,
              deepseekBaseUrl,
              deepseekModel,
              openaiApiKey,
              openaiBaseUrl,
              openaiModel,
              geminiApiKey,
              geminiBaseUrl,
              geminiModel,
            }),
      largeModel:
        typeof parsed.largeModel === 'string'
          ? parsed.largeModel
          : resolvePersistedProviderField(largeProvider, 'model', {
              deepseekApiKey,
              deepseekBaseUrl,
              deepseekModel,
              openaiApiKey,
              openaiBaseUrl,
              openaiModel,
              geminiApiKey,
              geminiBaseUrl,
              geminiModel,
            }),
      layeredAgentEnabled,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };

    // Auto-migrate legacy plaintext secrets to encrypted form.
    if (needsRewrite) {
      writePersistedConfig(resolved);
    }

    return resolved;
  } catch {
    return {};
  }
}

function writePersistedConfig(payload: PersistedAiRuntimeConfig) {
  const persisted: PersistedAiRuntimeConfig = {
    ...payload,
    deepseekApiKey: payload.deepseekApiKey !== undefined ? encryptSecret(payload.deepseekApiKey) : undefined,
    openaiApiKey: payload.openaiApiKey !== undefined ? encryptSecret(payload.openaiApiKey) : undefined,
    geminiApiKey: payload.geminiApiKey !== undefined ? encryptSecret(payload.geminiApiKey) : undefined,
    tavilyApiKey: payload.tavilyApiKey !== undefined ? encryptSecret(payload.tavilyApiKey) : undefined,
    smallApiKey: payload.smallApiKey !== undefined ? encryptSecret(payload.smallApiKey) : undefined,
    largeApiKey: payload.largeApiKey !== undefined ? encryptSecret(payload.largeApiKey) : undefined,
  };
  fs.writeFileSync(runtimeConfigPath, JSON.stringify(persisted, null, 2), 'utf8');
}

function applyRuntimeConfig(patch: PersistedAiRuntimeConfig) {
  if (patch.provider !== undefined) {
    env.aiProvider = normalizeProvider(patch.provider);
    process.env.AI_PROVIDER = env.aiProvider;
    if (patch.largeProvider === undefined) {
      env.aiLargeProvider = env.aiProvider;
      process.env.AI_LARGE_PROVIDER = env.aiProvider;
    }
  }

  if (patch.deepseekApiKey !== undefined) {
    env.deepseekApiKey = patch.deepseekApiKey;
    process.env.DEEPSEEK_API_KEY = patch.deepseekApiKey;
  }

  if (patch.deepseekBaseUrl !== undefined) {
    env.deepseekBaseUrl = patch.deepseekBaseUrl;
    process.env.DEEPSEEK_BASE_URL = patch.deepseekBaseUrl;
  }

  if (patch.deepseekModel !== undefined) {
    env.deepseekModel = patch.deepseekModel;
    process.env.DEEPSEEK_MODEL = patch.deepseekModel;
  }

  if (patch.openaiApiKey !== undefined) {
    env.openaiApiKey = patch.openaiApiKey;
    process.env.OPENAI_API_KEY = patch.openaiApiKey;
  }

  if (patch.openaiBaseUrl !== undefined) {
    env.openaiBaseUrl = patch.openaiBaseUrl;
    process.env.OPENAI_BASE_URL = patch.openaiBaseUrl;
  }

  if (patch.openaiModel !== undefined) {
    env.openaiModel = patch.openaiModel;
    process.env.OPENAI_MODEL = patch.openaiModel;
  }

  if (patch.geminiApiKey !== undefined) {
    env.geminiApiKey = patch.geminiApiKey;
    process.env.GEMINI_API_KEY = patch.geminiApiKey;
  }

  if (patch.geminiBaseUrl !== undefined) {
    env.geminiBaseUrl = patch.geminiBaseUrl;
    process.env.GEMINI_BASE_URL = patch.geminiBaseUrl;
  }

  if (patch.geminiModel !== undefined) {
    env.geminiModel = patch.geminiModel;
    process.env.GEMINI_MODEL = patch.geminiModel;
  }

  if (patch.tavilyApiKey !== undefined) {
    env.tavilyApiKey = patch.tavilyApiKey;
    process.env.TAVILY_API_KEY = patch.tavilyApiKey;
  }

  if (patch.tavilyBaseUrl !== undefined) {
    env.tavilyBaseUrl = patch.tavilyBaseUrl;
    process.env.TAVILY_BASE_URL = patch.tavilyBaseUrl;
  }

  if (patch.tavilyTopic !== undefined) {
    env.tavilyTopic = patch.tavilyTopic;
    process.env.TAVILY_TOPIC = patch.tavilyTopic;
  }

  if (patch.tavilyMaxResults !== undefined) {
    env.tavilyMaxResults = patch.tavilyMaxResults;
    process.env.TAVILY_MAX_RESULTS = String(patch.tavilyMaxResults);
  }

  if (patch.smallProvider !== undefined) {
    env.aiSmallProvider = normalizeProvider(patch.smallProvider);
    process.env.AI_SMALL_PROVIDER = env.aiSmallProvider;
  }

  if (patch.smallApiKey !== undefined) {
    env.aiSmallApiKey = patch.smallApiKey;
    process.env.AI_SMALL_API_KEY = patch.smallApiKey;
  }

  if (patch.smallBaseUrl !== undefined) {
    env.aiSmallBaseUrl = patch.smallBaseUrl;
    process.env.AI_SMALL_BASE_URL = patch.smallBaseUrl;
  }

  if (patch.smallModel !== undefined) {
    env.aiSmallModel = patch.smallModel;
    process.env.AI_SMALL_MODEL = patch.smallModel;
  }

  if (patch.largeProvider !== undefined) {
    env.aiLargeProvider = normalizeProvider(patch.largeProvider);
    process.env.AI_LARGE_PROVIDER = env.aiLargeProvider;
    env.aiProvider = env.aiLargeProvider;
    process.env.AI_PROVIDER = env.aiLargeProvider;
  }

  if (patch.largeApiKey !== undefined) {
    env.aiLargeApiKey = patch.largeApiKey;
    process.env.AI_LARGE_API_KEY = patch.largeApiKey;
  }

  if (patch.largeBaseUrl !== undefined) {
    env.aiLargeBaseUrl = patch.largeBaseUrl;
    process.env.AI_LARGE_BASE_URL = patch.largeBaseUrl;
  }

  if (patch.largeModel !== undefined) {
    env.aiLargeModel = patch.largeModel;
    process.env.AI_LARGE_MODEL = patch.largeModel;
  }

  if (patch.layeredAgentEnabled !== undefined) {
    env.aiLayeredAgentEnabled = Boolean(patch.layeredAgentEnabled);
    process.env.AI_LAYERED_AGENT_ENABLED = env.aiLayeredAgentEnabled ? 'true' : 'false';
  }
}

function normalizePatch(input: AiRuntimeConfigPatchInput): PersistedAiRuntimeConfig {
  const patch: PersistedAiRuntimeConfig = {};

  if (input.provider !== undefined) {
    patch.provider = normalizeProvider(input.provider);
    patch.largeProvider = patch.provider;
  }

  if (input.deepseekApiKey !== undefined) {
    patch.deepseekApiKey = (input.deepseekApiKey ?? '').trim();
  }

  if (input.deepseekBaseUrl !== undefined) {
    patch.deepseekBaseUrl = input.deepseekBaseUrl.trim();
  }

  if (input.deepseekModel !== undefined) {
    patch.deepseekModel = input.deepseekModel.trim();
  }

  if (input.openaiApiKey !== undefined) {
    patch.openaiApiKey = (input.openaiApiKey ?? '').trim();
  }

  if (input.openaiBaseUrl !== undefined) {
    patch.openaiBaseUrl = input.openaiBaseUrl.trim();
  }

  if (input.openaiModel !== undefined) {
    patch.openaiModel = input.openaiModel.trim();
  }

  if (input.geminiApiKey !== undefined) {
    patch.geminiApiKey = (input.geminiApiKey ?? '').trim();
  }

  if (input.geminiBaseUrl !== undefined) {
    patch.geminiBaseUrl = input.geminiBaseUrl.trim();
  }

  if (input.geminiModel !== undefined) {
    patch.geminiModel = input.geminiModel.trim();
  }

  if (input.tavilyApiKey !== undefined) {
    patch.tavilyApiKey = (input.tavilyApiKey ?? '').trim();
  }

  if (input.tavilyBaseUrl !== undefined) {
    patch.tavilyBaseUrl = input.tavilyBaseUrl.trim();
  }

  if (input.tavilyTopic !== undefined) {
    patch.tavilyTopic = normalizeTavilyTopic(input.tavilyTopic);
  }

  if (input.tavilyMaxResults !== undefined) {
    patch.tavilyMaxResults = clampTavilyMaxResults(input.tavilyMaxResults);
  }

  if (input.smallProvider !== undefined) {
    patch.smallProvider = normalizeProvider(input.smallProvider);
  }

  if (input.smallApiKey !== undefined) {
    patch.smallApiKey = (input.smallApiKey ?? '').trim();
  }

  if (input.smallBaseUrl !== undefined) {
    patch.smallBaseUrl = input.smallBaseUrl.trim();
  }

  if (input.smallModel !== undefined) {
    patch.smallModel = input.smallModel.trim();
  }

  if (input.largeProvider !== undefined) {
    patch.largeProvider = normalizeProvider(input.largeProvider);
  }

  if (input.largeApiKey !== undefined) {
    patch.largeApiKey = (input.largeApiKey ?? '').trim();
  }

  if (input.largeBaseUrl !== undefined) {
    patch.largeBaseUrl = input.largeBaseUrl.trim();
  }

  if (input.largeModel !== undefined) {
    patch.largeModel = input.largeModel.trim();
  }

  if (input.layeredAgentEnabled !== undefined) {
    patch.layeredAgentEnabled = Boolean(input.layeredAgentEnabled);
  }

  return patch;
}

function buildSnapshot(persisted: PersistedAiRuntimeConfig): AiRuntimeConfigSnapshot {
  const providerProfiles: Record<AiProvider, AiModelProfileSnapshot> = {
    deepseek: resolveProviderProfile('deepseek'),
    openai: resolveProviderProfile('openai'),
    gemini: resolveProviderProfile('gemini'),
  };
  const smallModelProfile = resolveRoleProfile('small');
  const largeModelProfile = resolveRoleProfile('large');
  const tavilyProfile = resolveTavilyProfile();

  return {
    provider: largeModelProfile.provider,
    runtime: env.aiRuntime,
    deepseekBaseUrl: env.deepseekBaseUrl,
    deepseekModel: env.deepseekModel,
    openaiBaseUrl: env.openaiBaseUrl,
    openaiModel: env.openaiModel,
    geminiBaseUrl: env.geminiBaseUrl,
    geminiModel: env.geminiModel,
    tavilyBaseUrl: env.tavilyBaseUrl,
    tavilyTopic: normalizeTavilyTopic(env.tavilyTopic),
    tavilyMaxResults: clampTavilyMaxResults(env.tavilyMaxResults),
    hasApiKey: largeModelProfile.hasApiKey,
    apiKeyMasked: largeModelProfile.apiKeyMasked,
    deepseekHasApiKey: Boolean(env.deepseekApiKey.trim()),
    deepseekApiKeyMasked: maskApiKey(env.deepseekApiKey),
    openaiHasApiKey: Boolean(env.openaiApiKey.trim()),
    openaiApiKeyMasked: maskApiKey(env.openaiApiKey),
    geminiHasApiKey: Boolean(env.geminiApiKey.trim()),
    geminiApiKeyMasked: maskApiKey(env.geminiApiKey),
    tavilyHasApiKey: tavilyProfile.hasApiKey,
    tavilyApiKeyMasked: tavilyProfile.apiKeyMasked,
    activeModel: largeModelProfile.model,
    providerProfiles,
    smallRoleProvider: smallModelProfile.provider,
    largeRoleProvider: largeModelProfile.provider,
    smallModelProfile,
    largeModelProfile,
    tavilyProfile,
    layeredAgentEnabled:
      typeof persisted.layeredAgentEnabled === 'boolean'
        ? persisted.layeredAgentEnabled
        : Boolean(env.aiLayeredAgentEnabled),
    updatedAt: persisted.updatedAt,
  };
}

const bootstrapConfig = readPersistedConfig();
applyRuntimeConfig(bootstrapConfig);

export function getAiRuntimeConfigSnapshot() {
  const persisted = readPersistedConfig();
  return buildSnapshot(persisted);
}

export function updateAiRuntimeConfig(input: AiRuntimeConfigPatchInput) {
  const patch = normalizePatch(input);
  const current = readPersistedConfig();
  const next: PersistedAiRuntimeConfig = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  applyRuntimeConfig(next);
  writePersistedConfig(next);

  return buildSnapshot(next);
}
