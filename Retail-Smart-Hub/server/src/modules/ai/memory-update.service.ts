import fs from 'node:fs';
import path from 'node:path';
import {
  buildProfileMemoryContextEntries,
  getProfileMemory,
  upsertProfileMemory,
  type ProfileMemoryScope,
} from './profile-memory.service';
import {
  captureConversationMemory,
  deleteConversationMemoryFact,
  listConversationMemoryFacts,
} from './rag.service';

export type MemoryDecisionAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';

export type MemoryFactTarget =
  | 'assistantDisplayName'
  | 'assistantAliases'
  | 'userPreferredName'
  | 'language'
  | 'stylePreferences'
  | 'permissionPolicyNote'
  | 'financePolicyNote'
  | 'accountPolicyNote';

export interface MemoryUpdateDecision {
  action: MemoryDecisionAction;
  target: MemoryFactTarget;
  oldValue: string | string[] | null;
  newValue: string | string[] | null;
  scopeType: ProfileMemoryScope;
  scopeId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  requiresApproval: boolean;
  riskLevel: 'low' | 'high';
  auditPayload: Record<string, unknown>;
}

export interface MemoryRuntimeRequest {
  prompt: string;
  userId: string;
  username: string;
  tenantId?: string;
  sessionId?: string;
}

export interface PlanMemoryUpdateInput extends MemoryRuntimeRequest {
  target?: string;
  newValue?: string;
  scopeType?: ProfileMemoryScope;
  scopeId?: string;
  appendOldValueToAliases?: boolean;
  deleteMode?: boolean;
}

export interface MemoryFactItem {
  factId: string;
  target: string;
  value: string;
  source: 'profile' | 'episodic' | 'sensitive';
  scopeType: ProfileMemoryScope;
  scopeId: string;
  riskLevel: 'low' | 'high';
  updatedAt: string;
}

type LowRiskTarget =
  | 'assistantDisplayName'
  | 'assistantAliases'
  | 'userPreferredName'
  | 'language'
  | 'stylePreferences';

type HighRiskTarget = 'permissionPolicyNote' | 'financePolicyNote' | 'accountPolicyNote';

interface SensitiveMemoryRecord {
  id: string;
  target: HighRiskTarget;
  value: string;
  scopeType: ProfileMemoryScope;
  scopeId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  status: 'active' | 'deleted';
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastConfirmedAt?: string;
}

const LOW_RISK_TARGETS: LowRiskTarget[] = [
  'assistantDisplayName',
  'assistantAliases',
  'userPreferredName',
  'language',
  'stylePreferences',
];

const HIGH_RISK_TARGETS: HighRiskTarget[] = ['permissionPolicyNote', 'financePolicyNote', 'accountPolicyNote'];

const LOW_RISK_TARGET_SET = new Set(LOW_RISK_TARGETS);
const HIGH_RISK_TARGET_SET = new Set(HIGH_RISK_TARGETS);
const DEFAULT_SCOPE: ProfileMemoryScope = 'user';

function sanitizeText(value: unknown, max = 200) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function normalizeListValue(value: string) {
  const dedup = new Set<string>();
  value
    .split(/[\uFF0C\uFF1B,;|]/)
    .map((item) => sanitizeText(item, 80))
    .filter(Boolean)
    .forEach((item) => dedup.add(item));
  return Array.from(dedup);
}

function normalizeLanguage(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  const zhHints = ['zh', 'zh-cn', 'chinese', '\u4e2d\u6587', '\u7b80\u4f53\u4e2d\u6587'];
  const enHints = ['en', 'en-us', 'english', '\u82f1\u6587', '\u82f1\u8bed'];

  if (zhHints.some((item) => normalized.includes(item.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))))) {
    return 'zh-CN';
  }
  if (enHints.some((item) => normalized.includes(item.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))))) {
    return 'en-US';
  }

  return sanitizeText(value, 24);
}

function getRagDataRoot() {
  const configuredDataRoot = process.env.RETAIL_SMART_HUB_DATA_DIR?.trim();
  const root = configuredDataRoot
    ? path.resolve(configuredDataRoot, 'rag')
    : path.resolve(process.cwd(), 'database', 'rag');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function getSensitiveStorePath() {
  return path.join(getRagDataRoot(), 'sensitive-memory-facts.jsonl');
}

function safeParseLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSensitiveMemoryRecords() {
  const filePath = getSensitiveStorePath();
  if (!fs.existsSync(filePath)) {
    return [] as SensitiveMemoryRecord[];
  }

  const rows = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const records: SensitiveMemoryRecord[] = [];
  for (const row of rows) {
    const raw = safeParseLine(row);
    if (!raw) {
      continue;
    }

    const target = sanitizeText(raw.target, 60) as HighRiskTarget;
    if (!HIGH_RISK_TARGET_SET.has(target)) {
      continue;
    }

    const scopeTypeRaw = sanitizeText(raw.scopeType, 20);
    if (!['global', 'tenant', 'user', 'session'].includes(scopeTypeRaw)) {
      continue;
    }

    const scopeType = scopeTypeRaw as ProfileMemoryScope;
    const scopeId = sanitizeText(raw.scopeId, 220);
    if (!scopeId) {
      continue;
    }

    const nowIso = new Date().toISOString();
    const versionRaw = Number(raw.version);
    records.push({
      id: sanitizeText(raw.id, 180) || `smf-${scopeId}-${target}`,
      target,
      value: sanitizeText(raw.value, 400),
      scopeType,
      scopeId,
      tenantId: sanitizeText(raw.tenantId, 80) || undefined,
      userId: sanitizeText(raw.userId, 80) || undefined,
      sessionId: sanitizeText(raw.sessionId, 120) || undefined,
      status: raw.status === 'deleted' ? 'deleted' : 'active',
      version: Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : 1,
      createdAt: sanitizeText(raw.createdAt, 60) || nowIso,
      updatedAt: sanitizeText(raw.updatedAt, 60) || nowIso,
      updatedBy: sanitizeText(raw.updatedBy, 120) || 'system',
      lastConfirmedAt: sanitizeText(raw.lastConfirmedAt, 60) || undefined,
    });
  }

  const dedup = new Map<string, SensitiveMemoryRecord>();
  for (const record of records) {
    const key = `${record.scopeId}::${record.target}`;
    const current = dedup.get(key);
    if (!current || record.version > current.version || record.updatedAt > current.updatedAt) {
      dedup.set(key, record);
    }
  }

  return Array.from(dedup.values());
}

function writeSensitiveMemoryRecords(records: SensitiveMemoryRecord[]) {
  const filePath = getSensitiveStorePath();
  if (records.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    return;
  }

  const lines = records
    .slice()
    .sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.target.localeCompare(b.target))
    .map((item) => JSON.stringify(item));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function resolveScope(input: {
  scopeType?: ProfileMemoryScope;
  scopeId?: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
}) {
  const scopeType = input.scopeType || DEFAULT_SCOPE;
  const tenantId = sanitizeText(input.tenantId, 80) || undefined;
  const userId = sanitizeText(input.userId, 80) || undefined;
  const sessionId = sanitizeText(input.sessionId, 120) || undefined;
  const explicitScopeId = sanitizeText(input.scopeId, 160);

  if (scopeType === 'global') {
    return {
      scopeType,
      scopeId: 'global',
      tenantId: undefined,
      userId: undefined,
      sessionId: undefined,
    };
  }

  if (scopeType === 'tenant') {
    const resolvedTenantId = explicitScopeId || tenantId;
    if (!resolvedTenantId) {
      throw new Error('tenant scope requires tenantId/scopeId');
    }
    return {
      scopeType,
      scopeId: `tenant:${resolvedTenantId}`,
      tenantId: resolvedTenantId,
      userId: undefined,
      sessionId: undefined,
    };
  }

  if (scopeType === 'user') {
    const resolvedUserId = explicitScopeId || userId;
    if (!resolvedUserId) {
      throw new Error('user scope requires userId/scopeId');
    }
    return {
      scopeType,
      scopeId: tenantId ? `user:${tenantId}:${resolvedUserId}` : `user:${resolvedUserId}`,
      tenantId,
      userId: resolvedUserId,
      sessionId: undefined,
    };
  }

  const resolvedSessionId = explicitScopeId || sessionId;
  if (!resolvedSessionId) {
    throw new Error('session scope requires sessionId/scopeId');
  }
  return {
    scopeType: 'session' as const,
    scopeId: tenantId
      ? userId
        ? `session:${tenantId}:${userId}:${resolvedSessionId}`
        : `session:${tenantId}:${resolvedSessionId}`
      : userId
        ? `session:${userId}:${resolvedSessionId}`
        : `session:${resolvedSessionId}`,
    tenantId,
    userId,
    sessionId: resolvedSessionId,
  };
}

function extractCandidateFact(prompt: string) {
  const text = prompt.trim();
  if (!text) {
    return null;
  }

  const normalized = text
    .replace(/[\u201C\u201D\u300C\u300D"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cutToken = (value: string) =>
    value
      .replace(/[\u3002\uFF0C\uFF1B,;.!?]/g, ' ')
      .trim()
      .split(/\s+/)[0]
      ?.slice(0, 24) || '';

  const extractAfterKeyword = (keywords: string[]) => {
    for (const keyword of keywords) {
      const index = normalized.indexOf(keyword);
      if (index < 0) {
        continue;
      }
      const tail = normalized.slice(index + keyword.length).trim();
      const value = cutToken(tail);
      if (value) {
        return value;
      }
    }
    return '';
  };

  const assistantName = extractAfterKeyword([
    '\u53eb\u4f60',
    '\u79f0\u547c\u4f60',
    '\u4f60\u53eb',
    '\u628a\u4f60\u7684\u540d\u5b57\u6539\u6210',
    '\u628a\u4f60\u540d\u5b57\u6539\u6210',
  ]);
  if (assistantName) {
    return { target: 'assistantDisplayName' as MemoryFactTarget, newValue: assistantName };
  }

  const userName = extractAfterKeyword(['\u4ee5\u540e\u53eb\u6211', '\u79f0\u547c\u6211', '\u4f60\u53eb\u6211', '\u6211\u53eb']);
  if (userName) {
    return { target: 'userPreferredName' as MemoryFactTarget, newValue: userName };
  }

  const zhRegex = /(zh-?cn|chinese|\u7b80\u4f53\u4e2d\u6587|\u4e2d\u6587\u56de\u590d|\u8bf4\u4e2d\u6587|\u4e2d\u6587)/i;
  if (zhRegex.test(normalized)) {
    return { target: 'language' as MemoryFactTarget, newValue: 'zh-CN' };
  }

  const enRegex = /(en-?us|english|\u82f1\u6587\u56de\u590d|\u8bf4\u82f1\u6587|\u82f1\u8bed|\u82f1\u6587)/i;
  if (enRegex.test(normalized)) {
    return { target: 'language' as MemoryFactTarget, newValue: 'en-US' };
  }

  const styleTokens: string[] = [];
  const conciseRegex = /(\u7b80\u6d01|\u7cbe\u70bc|\u77ed\u4e00\u70b9|\u7b80\u77ed|concise)/i;
  const detailedRegex = /(\u8be6\u7ec6|\u5c55\u5f00|\u591a\u89e3\u91ca|\u6b65\u9aa4|detailed)/i;
  const formalRegex = /(\u6b63\u5f0f|\u4e25\u8c28|\u4e13\u4e1a|formal)/i;

  if (conciseRegex.test(normalized)) {
    styleTokens.push('concise');
  }
  if (detailedRegex.test(normalized)) {
    styleTokens.push('detailed');
  }
  if (formalRegex.test(normalized)) {
    styleTokens.push('formal');
  }

  if (styleTokens.length > 0) {
    return { target: 'stylePreferences' as MemoryFactTarget, newValue: styleTokens.join(', ') };
  }

  return null;
}

function normalizeTarget(targetRaw: string | undefined, prompt: string): MemoryFactTarget | null {
  const normalized = sanitizeText(targetRaw, 60);
  if (normalized && (LOW_RISK_TARGET_SET.has(normalized as LowRiskTarget) || HIGH_RISK_TARGET_SET.has(normalized as HighRiskTarget))) {
    return normalized as MemoryFactTarget;
  }
  return extractCandidateFact(prompt)?.target || null;
}

function normalizeNewValue(target: MemoryFactTarget, rawValue: string | undefined, prompt: string) {
  const candidate = extractCandidateFact(prompt);
  const sourceValue = sanitizeText(rawValue, 400) || (candidate?.target === target ? sanitizeText(candidate.newValue, 400) : '');
  if (!sourceValue) {
    return null;
  }

  if (target === 'language') {
    return normalizeLanguage(sourceValue);
  }
  if (target === 'assistantAliases' || target === 'stylePreferences') {
    const items = normalizeListValue(sourceValue);
    return items.length > 0 ? items : null;
  }

  return sourceValue;
}

function getProfileTargetValue(
  target: LowRiskTarget,
  profile: Record<string, unknown>,
): string | string[] | null {
  switch (target) {
    case 'assistantDisplayName':
      return (typeof profile.assistantDisplayName === 'string' ? profile.assistantDisplayName : null) || null;
    case 'assistantAliases':
      return Array.isArray(profile.assistantAliases) ? (profile.assistantAliases as string[]) : null;
    case 'userPreferredName':
      return (typeof profile.userPreferredName === 'string' ? profile.userPreferredName : null) || null;
    case 'language':
      return (typeof profile.language === 'string' ? profile.language : null) || null;
    case 'stylePreferences':
      return Array.isArray(profile.stylePreferences) ? (profile.stylePreferences as string[]) : null;
    default:
      return null;
  }
}

function getCurrentTargetValues(target: MemoryFactTarget, scope: ReturnType<typeof resolveScope>) {
  if (LOW_RISK_TARGET_SET.has(target as LowRiskTarget)) {
    const resolved = getProfileMemory({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    const lowRiskTarget = target as LowRiskTarget;
    const effectiveValue = getProfileTargetValue(lowRiskTarget, resolved.profile as Record<string, unknown>);
    const scopedRecord = resolved.records.find((item) => item.scopeId === scope.scopeId);
    const scopedValue = scopedRecord
      ? getProfileTargetValue(lowRiskTarget, scopedRecord.profile as Record<string, unknown>)
      : null;
    return { effectiveValue, scopedValue };
  }

  const sensitive = readSensitiveMemoryRecords().find((item) => item.scopeId === scope.scopeId && item.target === target);
  if (!sensitive || sensitive.status !== 'active') {
    return { effectiveValue: null, scopedValue: null };
  }
  return { effectiveValue: sensitive.value, scopedValue: sensitive.value };
}

function isSameValue(left: string | string[] | null, right: string | string[] | null) {
  if (left == null && right == null) {
    return true;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left.trim() === right.trim();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => item === right[index]);
  }
  return false;
}

export function planMemoryUpdate(input: PlanMemoryUpdateInput): MemoryUpdateDecision {
  const scope = resolveScope({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
  });

  const target = normalizeTarget(input.target, input.prompt);
  if (!target) {
    throw new Error('Unable to detect memory target.');
  }

  const { effectiveValue, scopedValue } = getCurrentTargetValues(target, scope);
  const normalizedNewValue = input.deleteMode ? null : normalizeNewValue(target, input.newValue, input.prompt);

  let action: MemoryDecisionAction = 'NONE';
  if (input.deleteMode || normalizedNewValue == null || (typeof normalizedNewValue === 'string' && !normalizedNewValue.trim())) {
    action = scopedValue == null ? 'NONE' : 'DELETE';
  } else if (scopedValue == null) {
    action = isSameValue(effectiveValue, normalizedNewValue) ? 'NONE' : 'ADD';
  } else if (isSameValue(scopedValue, normalizedNewValue)) {
    action = 'NONE';
  } else {
    action = 'UPDATE';
  }

  const riskLevel: 'low' | 'high' = HIGH_RISK_TARGET_SET.has(target as HighRiskTarget) ? 'high' : 'low';
  const requiresApproval = riskLevel === 'high' && action !== 'NONE';
  const oldValue = scopedValue ?? effectiveValue;

  return {
    action,
    target,
    oldValue,
    newValue: normalizedNewValue,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    tenantId: scope.tenantId,
    userId: scope.userId,
    sessionId: scope.sessionId,
    requiresApproval,
    riskLevel,
    auditPayload: {
      target,
      action,
      oldValue,
      newValue: normalizedNewValue,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      riskLevel,
      requestedBy: input.username,
      requestedAt: new Date().toISOString(),
    },
  };
}

export function applyLowRiskMemoryUpdate(input: {
  decision: MemoryUpdateDecision;
  username: string;
  appendOldValueToAliases?: boolean;
  recordEpisodicEvent?: boolean;
}) {
  const { decision } = input;
  if (decision.riskLevel !== 'low') {
    throw new Error('High-risk memory update must go through approval.');
  }

  if (decision.action === 'NONE') {
    return {
      changed: false,
      summary: `No memory change needed for ${decision.target}.`,
      profile: getProfileMemory({
        tenantId: decision.tenantId,
        userId: decision.userId,
        sessionId: decision.sessionId,
      }).profile,
    };
  }

  const patch: Record<string, unknown> = {};
  if (decision.action === 'DELETE') {
    patch[decision.target] = null;
  } else {
    patch[decision.target] = decision.newValue;
  }

  if (
    decision.target === 'assistantDisplayName' &&
    decision.action === 'UPDATE' &&
    Boolean(input.appendOldValueToAliases) &&
    typeof decision.oldValue === 'string' &&
    decision.oldValue.trim()
  ) {
    const current = getProfileMemory({
      tenantId: decision.tenantId,
      userId: decision.userId,
      sessionId: decision.sessionId,
    }).profile;
    const aliases = new Set<string>(current.assistantAliases || []);
    aliases.add(decision.oldValue.trim());
    patch.assistantAliases = Array.from(aliases);
  }

  upsertProfileMemory({
    scope: decision.scopeType,
    tenantId: decision.tenantId,
    userId: decision.userId,
    sessionId: decision.sessionId,
    patch,
    updatedBy: input.username,
    lastConfirmedAt: new Date().toISOString(),
  });

  const resolved = getProfileMemory({
    tenantId: decision.tenantId,
    userId: decision.userId,
    sessionId: decision.sessionId,
  });

  if (input.recordEpisodicEvent !== false) {
    captureConversationMemory({
      userId: decision.userId || 'anonymous',
      tenantId: decision.tenantId,
      sessionId: decision.sessionId,
      prompt: `Update profile memory ${decision.target}.`,
      reply: `Profile memory updated: ${decision.action} ${decision.target}.`,
      citations: ['Profile Memory'],
    });
  }

  return {
    changed: true,
    summary: `Profile memory updated: ${decision.target} (${decision.action}).`,
    profile: resolved.profile,
  };
}

function upsertSensitiveMemoryRecord(input: {
  target: HighRiskTarget;
  value: string;
  scopeType: ProfileMemoryScope;
  scopeId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  updatedBy: string;
  markDeleted?: boolean;
}) {
  const records = readSensitiveMemoryRecords();
  const index = records.findIndex((item) => item.target === input.target && item.scopeId === input.scopeId);
  const nowIso = new Date().toISOString();
  const current = index >= 0 ? records[index] : null;

  const next: SensitiveMemoryRecord = {
    id: current?.id || `smf-${input.scopeId}-${input.target}`,
    target: input.target,
    value: sanitizeText(input.value, 400),
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
    status: input.markDeleted ? 'deleted' : 'active',
    version: (current?.version || 0) + 1,
    createdAt: current?.createdAt || nowIso,
    updatedAt: nowIso,
    updatedBy: input.updatedBy,
    lastConfirmedAt: nowIso,
  };

  if (index >= 0) {
    records[index] = next;
  } else {
    records.push(next);
  }
  writeSensitiveMemoryRecords(records);
}

export function applySensitiveMemoryPendingAction(input: {
  actionName: 'update_profile_memory_sensitive' | 'supersede_memory_fact_sensitive' | 'delete_memory_fact_sensitive';
  payload: {
    target: HighRiskTarget;
    newValue?: string;
    scopeType: ProfileMemoryScope;
    scopeId: string;
    tenantId?: string;
    userId?: string;
    sessionId?: string;
  };
  username: string;
}) {
  const target = input.payload.target;

  if (input.actionName === 'delete_memory_fact_sensitive') {
    upsertSensitiveMemoryRecord({
      target,
      value: '',
      scopeType: input.payload.scopeType,
      scopeId: input.payload.scopeId,
      tenantId: input.payload.tenantId,
      userId: input.payload.userId,
      sessionId: input.payload.sessionId,
      updatedBy: input.username,
      markDeleted: true,
    });

    return {
      summary: `Deleted high-risk memory fact: ${target}.`,
      reply: `Confirmed and deleted high-risk memory fact ${target}.`,
      executionResult: {
        action: 'DELETE',
        target,
      },
    };
  }

  const newValue = sanitizeText(input.payload.newValue, 400);
  if (!newValue) {
    throw new Error('High-risk memory update requires newValue.');
  }

  upsertSensitiveMemoryRecord({
    target,
    value: newValue,
    scopeType: input.payload.scopeType,
    scopeId: input.payload.scopeId,
    tenantId: input.payload.tenantId,
    userId: input.payload.userId,
    sessionId: input.payload.sessionId,
    updatedBy: input.username,
    markDeleted: false,
  });

  return {
    summary: `Updated high-risk memory fact: ${target}.`,
    reply: `Confirmed and updated high-risk memory fact ${target}.`,
    executionResult: {
      action: input.actionName === 'supersede_memory_fact_sensitive' ? 'UPDATE' : 'ADD',
      target,
      newValue,
    },
  };
}

export function listMemoryFacts(input: {
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  includeEpisodic?: boolean;
  limit?: number;
}): MemoryFactItem[] {
  const profileResolved = getProfileMemory({
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
  });

  const profileFacts = buildProfileMemoryContextEntries(profileResolved.profile).map((entry) => ({
    factId: `profile:${entry.key}`,
    target: entry.key,
    value: entry.value,
    source: 'profile' as const,
    scopeType: 'user' as const,
    scopeId: input.userId ? `user:${input.userId}` : 'global',
    riskLevel: LOW_RISK_TARGET_SET.has(entry.key as LowRiskTarget) ? ('low' as const) : ('high' as const),
    updatedAt: profileResolved.updatedAt || new Date().toISOString(),
  }));

  const sensitiveFacts = readSensitiveMemoryRecords()
    .filter((item) => item.status === 'active')
    .filter((item) => {
      if (input.tenantId && item.tenantId && item.tenantId !== input.tenantId) {
        return false;
      }
      if (input.userId && item.userId && item.userId !== input.userId) {
        return false;
      }
      if (input.sessionId && item.sessionId && item.sessionId !== input.sessionId) {
        return false;
      }
      return true;
    })
    .map((item) => ({
      factId: `sensitive:${item.target}:${item.scopeId}`,
      target: item.target,
      value: item.value,
      source: 'sensitive' as const,
      scopeType: item.scopeType,
      scopeId: item.scopeId,
      riskLevel: 'high' as const,
      updatedAt: item.updatedAt,
    }));

  const episodicFacts = input.includeEpisodic
    ? listConversationMemoryFacts({
        userId: input.userId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        limit: Math.max(1, Math.min(20, Number(input.limit) || 8)),
      }).map((item) => ({
        factId: item.id,
        target: item.title,
        value: item.content.length > 160 ? `${item.content.slice(0, 160)}...` : item.content,
        source: 'episodic' as const,
        scopeType: item.sessionId ? ('session' as const) : ('user' as const),
        scopeId: item.sessionId || item.userId,
        riskLevel: 'low' as const,
        updatedAt: item.lastAccessAt,
      }))
    : [];

  return [...profileFacts, ...sensitiveFacts, ...episodicFacts];
}

export function deleteMemoryFactById(input: {
  factId: string;
  userId: string;
  tenantId?: string;
  sessionId?: string;
  username: string;
}) {
  const factId = sanitizeText(input.factId, 220);
  if (!factId) {
    throw new Error('factId is required');
  }

  if (factId.startsWith('profile:')) {
    const target = factId.replace('profile:', '').trim();
    return planMemoryUpdate({
      prompt: `delete ${target}`,
      userId: input.userId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      username: input.username,
      target,
      deleteMode: true,
    });
  }

  if (factId.startsWith('sensitive:')) {
    const target = factId.split(':')[1] || '';
    return planMemoryUpdate({
      prompt: `delete ${target}`,
      userId: input.userId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      username: input.username,
      target,
      deleteMode: true,
    });
  }

  if (factId.startsWith('mem-')) {
    const removed = deleteConversationMemoryFact({
      id: factId,
      userId: input.userId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
    });

    return {
      action: removed.deleted ? ('DELETE' as const) : ('NONE' as const),
      target: 'stylePreferences' as MemoryFactTarget,
      oldValue: removed.deleted ? factId : null,
      newValue: null,
      scopeType: input.sessionId ? ('session' as const) : ('user' as const),
      scopeId: input.sessionId || input.userId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      requiresApproval: false,
      riskLevel: 'low' as const,
      auditPayload: {
        factId,
        removed,
      },
    };
  }

  throw new Error('unsupported factId');
}
