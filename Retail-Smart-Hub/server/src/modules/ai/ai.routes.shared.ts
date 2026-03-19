import { appendAuditLog } from '../../database/db';
import { ApiError } from '../../shared/api-error';
import { captureConversationMemory } from './rag.service';
import type { AiChatRequest, AiChatResponse, AiChatStreamMeta, AiResolvedRuntime } from './ai.service';

export interface AiAuthContext {
  id?: string;
  department?: string;
  username?: string;
  roles?: string[];
  permissions?: string[];
  token?: string;
}

interface AiRequestLike {
  auth?: AiAuthContext;
}

type CaptureConversationMemoryFn = typeof captureConversationMemory;
type AppendAuditLogFn = typeof appendAuditLog;
interface CaptureConversationMemoryResult {
  captured: boolean;
  id?: string;
  mode?: string;
  reason?: string;
}
type AiMemoryCaptureMode =
  | 'python-captured'
  | 'python-failed-node-backfilled'
  | 'capture-failed';

interface AiMemoryCaptureResult {
  captured: boolean;
  owner: 'python' | 'node-backfill';
  reason?: string;
  error?: string;
}

interface AiMemoryAuditResult extends AiMemoryCaptureResult {
  mode: AiMemoryCaptureMode;
  id?: string;
}

export interface FinalizeAiChatSideEffectsResult {
  memoryCapture: AiMemoryCaptureResult;
  mode: AiMemoryCaptureMode;
  id?: string;
}

export function writeSseEvent(res: { write: (chunk: string) => void }, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildAuditPayload(input: {
  username: string;
  result: AiChatResponse;
  prompt: string;
  conversationId: string;
  attachments: NonNullable<AiChatRequest['attachments']>;
  runtimeUsed: AiResolvedRuntime;
  memoryResult: AiMemoryAuditResult;
}) {
  return {
    by: input.username,
    model: input.result.model,
    provider: input.result.provider,
    configured: input.result.configured,
    citationCount: input.result.citations.length,
    citations: input.result.citations,
    webSourceCount: Array.isArray(input.result.webSources) ? input.result.webSources.length : 0,
    promptPreview: input.prompt.slice(0, 120),
    promptLength: input.prompt.length,
    conversationId: input.conversationId || 'default',
    memoryCaptured: input.memoryResult.captured,
    memoryReason: input.memoryResult.reason || input.memoryResult.mode,
    memoryCaptureMode: input.memoryResult.mode,
    memoryCaptureOwner: input.memoryResult.owner,
    memoryError: input.memoryResult.error,
    memoryId: input.memoryResult.id,
    attachmentCount: input.attachments.length,
    attachmentNames: input.attachments.map((item) => item.fileName),
    runtimeUsed: input.runtimeUsed,
  };
}

interface PythonMemoryCaptureOutcome {
  captured: boolean;
  owner?: 'python' | 'node-backfill';
  reason?: string;
  error?: string;
}

function resolvePythonMemoryCapture(result: AiChatResponse): PythonMemoryCaptureOutcome | undefined {
  const payload = (result as { memoryCapture?: unknown }).memoryCapture;
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const captured = (payload as { captured?: unknown }).captured;
  if (typeof captured !== 'boolean') {
    return undefined;
  }
  const owner = (payload as { owner?: unknown }).owner;
  const reason = (payload as { reason?: unknown }).reason;
  const error = (payload as { error?: unknown }).error;
  return {
    captured,
    owner: owner === 'python' || owner === 'node-backfill' ? owner : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
    error: typeof error === 'string' ? error : undefined,
  };
}

function captureConversationMemorySafely(
  captureConversationMemoryFn: CaptureConversationMemoryFn,
  input: Parameters<CaptureConversationMemoryFn>[0],
) {
  try {
    return {
      result: captureConversationMemoryFn(input) as CaptureConversationMemoryResult,
    };
  } catch (error) {
    return {
      result: {
        captured: false,
        reason: 'capture-exception',
      } satisfies CaptureConversationMemoryResult,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function finalizeAiChatSideEffects(input: {
  authUserId: string;
  authUsername: string;
  tenantId?: string;
  prompt: string;
  conversationId: string;
  attachments: NonNullable<AiChatRequest['attachments']>;
  result: AiChatResponse;
  runtimeUsed: AiResolvedRuntime;
  captureConversationMemoryFn?: CaptureConversationMemoryFn;
  appendAuditLogFn?: AppendAuditLogFn;
}): FinalizeAiChatSideEffectsResult {
  const captureConversationMemoryFn = input.captureConversationMemoryFn ?? captureConversationMemory;
  const appendAuditLogFn = input.appendAuditLogFn ?? appendAuditLog;
  const pythonOutcome = input.runtimeUsed === 'python' ? resolvePythonMemoryCapture(input.result) : undefined;
  let memoryResult: AiMemoryAuditResult;

  if (input.runtimeUsed === 'python' && pythonOutcome?.captured === true) {
    memoryResult = {
      captured: true,
      mode: 'python-captured',
      owner: pythonOutcome.owner ?? 'python',
      reason: pythonOutcome.reason,
      error: pythonOutcome.error,
    };
  } else {
    const { result: backfill, error: backfillError } = captureConversationMemorySafely(captureConversationMemoryFn, {
      userId: input.authUserId,
      tenantId: input.tenantId,
      sessionId: input.conversationId || undefined,
      prompt: input.prompt,
      reply: input.result.reply,
      citations: input.result.citations,
    });
    const fallbackReason =
      pythonOutcome?.error ||
      pythonOutcome?.reason ||
      backfillError ||
      backfill.reason ||
      'python-memory-missing';

    if (backfill.captured) {
      memoryResult = {
        captured: true,
        mode: 'python-failed-node-backfilled',
        owner: 'node-backfill',
        reason: fallbackReason,
        error: pythonOutcome?.error || backfillError,
        id: backfill.id,
      };
    } else {
      memoryResult = {
        captured: false,
        mode: 'capture-failed',
        owner: 'node-backfill',
        reason: fallbackReason,
        error: pythonOutcome?.error || backfillError,
      };
    }
  }

  const memoryCapture: AiMemoryCaptureResult = {
    captured: memoryResult.captured,
    owner: memoryResult.owner,
    reason: memoryResult.reason,
    error: memoryResult.error,
  };
  input.result.memoryCapture = memoryCapture;

  try {
    appendAuditLogFn(
      'ai_chat',
      'ai',
      input.authUserId,
      buildAuditPayload({
        username: input.authUsername,
        result: input.result,
        prompt: input.prompt,
        conversationId: input.conversationId,
        attachments: input.attachments,
        runtimeUsed: input.runtimeUsed,
        memoryResult,
      }),
    );
  } catch (error) {
    console.warn('[ai] failed to append chat audit log', error);
  }

  return {
    memoryCapture,
    mode: memoryResult.mode,
    id: memoryResult.id,
  };
}

export function buildAiChatRuntimeRequest(input: {
  prompt: string;
  conversationId: string;
  attachments: NonNullable<AiChatRequest['attachments']>;
  history: NonNullable<AiChatRequest['history']>;
  req: AiRequestLike;
}): AiChatRequest {
  const { req, prompt, conversationId, attachments, history } = input;
  return {
    prompt,
    conversationId: conversationId || undefined,
    userId: req.auth?.id || 'anonymous',
    tenantId: resolveTenantId(req.auth?.department),
    username: req.auth?.username || 'unknown',
    roles: req.auth?.roles || [],
    permissions: req.auth?.permissions || [],
    token: req.auth?.token || '',
    attachments,
    history,
  };
}

export function metaToEnvelope(meta: AiChatStreamMeta) {
  return {
    configured: meta.configured,
    provider: meta.provider,
    model: meta.model,
    toolCalls: meta.toolCalls,
    citations: meta.citations,
    webSources: meta.webSources,
    answer_meta: meta.answer_meta,
    pendingAction: meta.pendingAction,
    approval: meta.approval,
    note: meta.note,
    trace: meta.trace,
  };
}

export function resolveTenantId(rawTenant: string | undefined) {
  const tenant = rawTenant?.trim();
  return tenant || undefined;
}

function hasAccessControlPermission(permissions: string[]) {
  return permissions.includes('settings.access-control');
}

export function normalizeScopedIdentity(input: {
  requestedTenantId?: string;
  requestedUserId?: string;
  requestedSessionId?: string;
  authTenantId?: string;
  authUserId?: string;
  permissions: string[];
}) {
  const canManageCrossScope = hasAccessControlPermission(input.permissions);
  const requestedTenantId = input.requestedTenantId?.trim() || undefined;
  const requestedUserId = input.requestedUserId?.trim() || undefined;
  const requestedSessionId = input.requestedSessionId?.trim() || undefined;
  const authTenantId = input.authTenantId?.trim() || undefined;
  const authUserId = input.authUserId?.trim() || undefined;

  if (!canManageCrossScope) {
    if (requestedTenantId && requestedTenantId !== authTenantId) {
      throw new ApiError(403, '无权访问其他租户记忆。', 'PERMISSION_DENIED');
    }
    if (requestedUserId && requestedUserId !== authUserId) {
      throw new ApiError(403, '无权访问其他用户记忆。', 'PERMISSION_DENIED');
    }
  }

  return {
    canManageCrossScope,
    tenantId: canManageCrossScope ? requestedTenantId || authTenantId : authTenantId,
    userId: canManageCrossScope ? requestedUserId || authUserId : authUserId,
    sessionId: requestedSessionId,
  };
}

export const memoryNotes = [
  '当前记忆会影响后续回答。',
  '删除后不会再用于未来回答。',
  '记忆优先级：会话级 > 用户级 > 租户级 > 全局级。',
];
