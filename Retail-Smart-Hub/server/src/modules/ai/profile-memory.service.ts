import fs from 'node:fs';
import path from 'node:path';

export type ProfileMemoryScope = 'global' | 'tenant' | 'user' | 'session';

export interface ProfileMemoryValue {
  assistantDisplayName?: string;
  assistantAliases?: string[];
  userPreferredName?: string;
  language?: string;
  stylePreferences?: string[];
}

export interface ProfileMemoryPatch {
  assistantDisplayName?: string | null;
  assistantAliases?: string[] | null;
  userPreferredName?: string | null;
  language?: string | null;
  stylePreferences?: string[] | null;
}

export interface ProfileMemoryRecord {
  id: string;
  scope: ProfileMemoryScope;
  scopeId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  profile: ProfileMemoryValue;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastConfirmedAt?: string;
}

export interface ProfileMemoryScopeInput {
  scope: ProfileMemoryScope;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
}

export interface ProfileMemoryLookupInput {
  tenantId?: string;
  userId?: string;
  sessionId?: string;
}

export interface UpsertProfileMemoryInput extends ProfileMemoryScopeInput {
  patch: ProfileMemoryPatch;
  updatedBy: string;
  lastConfirmedAt?: string;
}

export interface ProfileMemoryResolved {
  profile: ProfileMemoryValue;
  records: ProfileMemoryRecord[];
  version: number;
  updatedAt: string;
  updatedBy: string;
  lastConfirmedAt?: string;
}

export interface ProfileMemoryContextEntry {
  key: string;
  value: string;
}

function getRagDataRoot() {
  const configuredDataRoot = process.env.RETAIL_SMART_HUB_DATA_DIR?.trim();
  const root = configuredDataRoot
    ? path.resolve(configuredDataRoot, 'rag')
    : path.resolve(process.cwd(), 'database', 'rag');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function getProfileMemoryPath() {
  return path.join(getRagDataRoot(), 'profile-memory.jsonl');
}

function toIso(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    return '';
  }
  return new Date(ts).toISOString();
}

function cleanString(value: unknown, maxLength = 120) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function cleanStringList(value: unknown, maxLength = 12) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deduped = new Set<string>();
  for (const item of value) {
    const normalized = cleanString(item, 80);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
    if (deduped.size >= maxLength) {
      break;
    }
  }
  return deduped.size > 0 ? Array.from(deduped) : undefined;
}

function normalizeProfile(value: unknown): ProfileMemoryValue {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    assistantDisplayName: cleanString(raw.assistantDisplayName, 80),
    assistantAliases: cleanStringList(raw.assistantAliases, 10),
    userPreferredName: cleanString(raw.userPreferredName, 80),
    language: cleanString(raw.language, 24),
    stylePreferences: cleanStringList(raw.stylePreferences, 12),
  };
}

function hasProfileValues(value: ProfileMemoryValue) {
  return Boolean(
    value.assistantDisplayName ||
      (value.assistantAliases && value.assistantAliases.length > 0) ||
      value.userPreferredName ||
      value.language ||
      (value.stylePreferences && value.stylePreferences.length > 0),
  );
}

function normalizeScopeInput(input: ProfileMemoryScopeInput) {
  const tenantId = cleanString(input.tenantId, 80);
  const userId = cleanString(input.userId, 80);
  const sessionId = cleanString(input.sessionId, 120);

  if (input.scope === 'global') {
    return { scope: 'global' as const, scopeId: 'global' };
  }

  if (input.scope === 'tenant') {
    if (!tenantId) {
      throw new Error('tenant scope requires tenantId');
    }
    return {
      scope: 'tenant' as const,
      scopeId: `tenant:${tenantId}`,
      tenantId,
    };
  }

  if (input.scope === 'user') {
    if (!userId) {
      throw new Error('user scope requires userId');
    }
    return {
      scope: 'user' as const,
      scopeId: tenantId ? `user:${tenantId}:${userId}` : `user:${userId}`,
      tenantId,
      userId,
    };
  }

  if (!sessionId) {
    throw new Error('session scope requires sessionId');
  }

  return {
    scope: 'session' as const,
    scopeId: tenantId
      ? userId
        ? `session:${tenantId}:${userId}:${sessionId}`
        : `session:${tenantId}:${sessionId}`
      : userId
        ? `session:${userId}:${sessionId}`
        : `session:${sessionId}`,
    tenantId,
    userId,
    sessionId,
  };
}

function safeParseLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readProfileRecords() {
  const filePath = getProfileMemoryPath();
  if (!fs.existsSync(filePath)) {
    return [] as ProfileMemoryRecord[];
  }

  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const nowIso = new Date().toISOString();
  const deduped = new Map<string, ProfileMemoryRecord>();

  for (const line of lines) {
    const raw = safeParseLine(line);
    if (!raw) {
      continue;
    }

    const scopeRaw = raw.scope;
    const scope: ProfileMemoryScope | null =
      scopeRaw === 'global' || scopeRaw === 'tenant' || scopeRaw === 'user' || scopeRaw === 'session'
        ? scopeRaw
        : null;
    if (!scope) {
      continue;
    }

    const scopeId = cleanString(raw.scopeId, 220);
    if (!scopeId) {
      continue;
    }

    const updatedAt = toIso(raw.updatedAt) || nowIso;
    const createdAt = toIso(raw.createdAt) || updatedAt;
    const versionRaw = Number(raw.version);
    const version = Number.isFinite(versionRaw) && versionRaw >= 1 ? Math.floor(versionRaw) : 1;
    const updatedBy = cleanString(raw.updatedBy, 120) || 'system';
    const profile = normalizeProfile(raw.profile);
    if (!hasProfileValues(profile)) {
      continue;
    }

    const record: ProfileMemoryRecord = {
      id: cleanString(raw.id, 140) || `profile-${scopeId}`,
      scope,
      scopeId,
      tenantId: cleanString(raw.tenantId, 80),
      userId: cleanString(raw.userId, 80),
      sessionId: cleanString(raw.sessionId, 120),
      profile,
      version,
      createdAt,
      updatedAt,
      updatedBy,
      lastConfirmedAt: toIso(raw.lastConfirmedAt) || undefined,
    };

    const existing = deduped.get(scopeId);
    if (!existing) {
      deduped.set(scopeId, record);
      continue;
    }

    if (record.version > existing.version || record.updatedAt > existing.updatedAt) {
      deduped.set(scopeId, record);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

function writeProfileRecords(records: ProfileMemoryRecord[]) {
  const filePath = getProfileMemoryPath();
  if (records.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    return;
  }

  const lines = records
    .slice()
    .sort((a, b) => a.scopeId.localeCompare(b.scopeId))
    .map((record) => JSON.stringify(record));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

export function mergeProfilePatch(base: ProfileMemoryValue, patch: ProfileMemoryPatch): ProfileMemoryValue {
  const next: ProfileMemoryValue = {
    assistantDisplayName: base.assistantDisplayName,
    assistantAliases: base.assistantAliases ? [...base.assistantAliases] : undefined,
    userPreferredName: base.userPreferredName,
    language: base.language,
    stylePreferences: base.stylePreferences ? [...base.stylePreferences] : undefined,
  };

  if (patch.assistantDisplayName !== undefined) {
    next.assistantDisplayName = patch.assistantDisplayName === null ? undefined : cleanString(patch.assistantDisplayName, 80);
  }
  if (patch.assistantAliases !== undefined) {
    next.assistantAliases = patch.assistantAliases === null ? undefined : cleanStringList(patch.assistantAliases, 10);
  }
  if (patch.userPreferredName !== undefined) {
    next.userPreferredName = patch.userPreferredName === null ? undefined : cleanString(patch.userPreferredName, 80);
  }
  if (patch.language !== undefined) {
    next.language = patch.language === null ? undefined : cleanString(patch.language, 24);
  }
  if (patch.stylePreferences !== undefined) {
    next.stylePreferences = patch.stylePreferences === null ? undefined : cleanStringList(patch.stylePreferences, 12);
  }

  return next;
}

function buildLookupChain(input: ProfileMemoryLookupInput) {
  const chain: Array<{ scope: ProfileMemoryScope; scopeId: string }> = [{ scope: 'global', scopeId: 'global' }];
  const tenantId = cleanString(input.tenantId, 80);
  const userId = cleanString(input.userId, 80);
  const sessionId = cleanString(input.sessionId, 120);

  if (tenantId) {
    chain.push({ scope: 'tenant' as const, scopeId: `tenant:${tenantId}` });
  }
  if (userId) {
    chain.push({
      scope: 'user' as const,
      scopeId: tenantId ? `user:${tenantId}:${userId}` : `user:${userId}`,
    });
  }
  if (sessionId) {
    chain.push({
      scope: 'session' as const,
      scopeId: tenantId
        ? userId
          ? `session:${tenantId}:${userId}:${sessionId}`
          : `session:${tenantId}:${sessionId}`
        : userId
          ? `session:${userId}:${sessionId}`
          : `session:${sessionId}`,
    });
  }

  return chain;
}

export function getProfileMemory(input: ProfileMemoryLookupInput): ProfileMemoryResolved {
  const all = readProfileRecords();
  const byScopeId = new Map(all.map((item) => [item.scopeId, item]));
  const chain = buildLookupChain(input);
  const records = chain
    .map((entry) => byScopeId.get(entry.scopeId))
    .filter((record): record is ProfileMemoryRecord => Boolean(record));

  const merged = records.reduce<ProfileMemoryValue>((acc, record) => mergeProfilePatch(acc, record.profile), {});
  const latest = records.reduce<ProfileMemoryRecord | null>((acc, record) => {
    if (!acc) {
      return record;
    }
    if (record.updatedAt > acc.updatedAt) {
      return record;
    }
    if (record.updatedAt === acc.updatedAt && record.version > acc.version) {
      return record;
    }
    return acc;
  }, null);

  return {
    profile: merged,
    records,
    version: latest?.version || 0,
    updatedAt: latest?.updatedAt || '',
    updatedBy: latest?.updatedBy || '',
    lastConfirmedAt: latest?.lastConfirmedAt,
  };
}

export function getProfileMemoryByScope(input: ProfileMemoryScopeInput): ProfileMemoryResolved {
  const all = readProfileRecords();
  const normalizedScope = normalizeScopeInput(input);
  const target = all.find((item) => item.scopeId === normalizedScope.scopeId);
  if (!target) {
    return {
      profile: {},
      records: [],
      version: 0,
      updatedAt: '',
      updatedBy: '',
      lastConfirmedAt: undefined,
    };
  }
  return {
    profile: target.profile,
    records: [target],
    version: target.version,
    updatedAt: target.updatedAt,
    updatedBy: target.updatedBy,
    lastConfirmedAt: target.lastConfirmedAt,
  };
}

export function upsertProfileMemory(input: UpsertProfileMemoryInput): ProfileMemoryRecord {
  const normalizedScope = normalizeScopeInput(input);
  const updatedBy = cleanString(input.updatedBy, 120) || 'system';
  const nowIso = new Date().toISOString();

  const records = readProfileRecords();
  const index = records.findIndex((item) => item.scopeId === normalizedScope.scopeId);
  const current = index >= 0 ? records[index] : null;

  const nextProfile = mergeProfilePatch(current?.profile || {}, input.patch);
  if (!hasProfileValues(nextProfile)) {
    if (index >= 0) {
      records.splice(index, 1);
      writeProfileRecords(records);
    }
    return {
      id: current?.id || `profile-${normalizedScope.scopeId}`,
      scope: normalizedScope.scope,
      scopeId: normalizedScope.scopeId,
      tenantId: normalizedScope.tenantId,
      userId: normalizedScope.userId,
      sessionId: normalizedScope.sessionId,
      profile: {},
      version: current?.version || 0,
      createdAt: current?.createdAt || nowIso,
      updatedAt: nowIso,
      updatedBy,
      lastConfirmedAt: input.lastConfirmedAt ? toIso(input.lastConfirmedAt) || nowIso : current?.lastConfirmedAt,
    };
  }

  const nextRecord: ProfileMemoryRecord = {
    id: current?.id || `profile-${normalizedScope.scopeId}`,
    scope: normalizedScope.scope,
    scopeId: normalizedScope.scopeId,
    tenantId: normalizedScope.tenantId,
    userId: normalizedScope.userId,
    sessionId: normalizedScope.sessionId,
    profile: nextProfile,
    version: (current?.version || 0) + 1,
    createdAt: current?.createdAt || nowIso,
    updatedAt: nowIso,
    updatedBy,
    lastConfirmedAt: input.lastConfirmedAt ? toIso(input.lastConfirmedAt) || nowIso : current?.lastConfirmedAt,
  };

  if (index >= 0) {
    records[index] = nextRecord;
  } else {
    records.push(nextRecord);
  }
  writeProfileRecords(records);
  return nextRecord;
}

export function buildProfileMemoryContextEntries(profile: ProfileMemoryValue): ProfileMemoryContextEntry[] {
  const entries: ProfileMemoryContextEntry[] = [];
  if (profile.assistantDisplayName) {
    entries.push({ key: 'assistantDisplayName', value: profile.assistantDisplayName });
  }
  if (profile.assistantAliases && profile.assistantAliases.length > 0) {
    entries.push({ key: 'assistantAliases', value: profile.assistantAliases.join(', ') });
  }
  if (profile.userPreferredName) {
    entries.push({ key: 'userPreferredName', value: profile.userPreferredName });
  }
  if (profile.language) {
    entries.push({ key: 'language', value: profile.language });
  }
  if (profile.stylePreferences && profile.stylePreferences.length > 0) {
    entries.push({ key: 'stylePreferences', value: profile.stylePreferences.join(', ') });
  }
  return entries;
}

export function buildProfileMemoryContext(input: ProfileMemoryLookupInput) {
  const resolved = getProfileMemory(input);
  const entries = buildProfileMemoryContextEntries(resolved.profile);

  if (entries.length === 0) {
    return {
      context: 'No active profile memory facts.',
      resolved,
      hasFacts: false,
    };
  }

  const lines = entries.map((entry) => `- ${entry.key}: ${entry.value}`);
  if (resolved.updatedAt) {
    lines.push(`- profileUpdatedAt: ${resolved.updatedAt}`);
  }
  if (resolved.updatedBy) {
    lines.push(`- profileUpdatedBy: ${resolved.updatedBy}`);
  }
  if (resolved.lastConfirmedAt) {
    lines.push(`- profileLastConfirmedAt: ${resolved.lastConfirmedAt}`);
  }

  return {
    context: ['Profile Memory (current effective facts):', ...lines].join('\n'),
    resolved,
    hasFacts: true,
  };
}

export function resetProfileMemoryForTest() {
  const filePath = getProfileMemoryPath();
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}
