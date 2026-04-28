import { appendAuditLog } from '../../database/db';
import { ApiError } from '../../shared/api-error';
import { captureConversationMemory } from './rag.service';
import type { AiChatRequest, AiChatResponse, AiChatStreamMeta, AiResolvedRuntime } from './ai.service';
import {
  getInterruptionCheckpointForResume,
  markInterruptionCheckpointResolved,
  markInterruptionCheckpointResumed,
  saveInterruptionCheckpoint,
  type StoredInterruptionCheckpoint,
} from './interruption-checkpoint.service';

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

export interface ResolvedAiRuntimeRequest {
  runtimeRequest: AiChatRequest;
  resumedCheckpoint?: StoredInterruptionCheckpoint;
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
  resume?: AiChatRequest['resume'];
  attachments: NonNullable<AiChatRequest['attachments']>;
  history: NonNullable<AiChatRequest['history']>;
  req: AiRequestLike;
}): AiChatRequest {
  const { req, prompt, conversationId, resume, attachments, history } = input;
  return {
    prompt,
    conversationId: conversationId || undefined,
    resume,
    userId: req.auth?.id || 'anonymous',
    tenantId: resolveTenantId(req.auth?.department),
    username: req.auth?.username || 'unknown',
    roles: req.auth?.roles || [],
    permissions: req.auth?.permissions || [],
    token: req.auth?.token || '',
    attachments,
    history,
    ...((input as any).conversationMessages?.length ? { conversationMessages: (input as any).conversationMessages } : {}),
  };
}

function appendHistoryTurn(
  history: NonNullable<AiChatRequest['history']>,
  turn: NonNullable<AiChatRequest['history']>[number],
) {
  const last = history[history.length - 1];
  if (
    last &&
    last.role === turn.role &&
    last.content === turn.content &&
    JSON.stringify(last.toolCalls || []) === JSON.stringify(turn.toolCalls || [])
  ) {
    return;
  }
  history.push(turn);
}

function buildHistoryFromCheckpoint(checkpoint: StoredInterruptionCheckpoint) {
  const restored = [...checkpoint.requestHistory];
  appendHistoryTurn(restored, {
    role: 'user',
    content: checkpoint.requestPrompt,
  });
  appendHistoryTurn(restored, {
    role: 'assistant',
    content: checkpoint.assistantReply,
    toolCalls: checkpoint.assistantToolCalls,
    pendingActionId: checkpoint.assistantPendingAction?.id,
    pendingActionName: checkpoint.assistantPendingAction?.name,
    pendingActionStatus: checkpoint.assistantPendingAction?.status,
  });
  return restored.slice(-8);
}

export function buildAiChatRuntimeRequestWithCheckpoint(input: {
  prompt: string;
  conversationId: string;
  resume?: AiChatRequest['resume'];
  attachments: NonNullable<AiChatRequest['attachments']>;
  history: NonNullable<AiChatRequest['history']>;
  req: AiRequestLike;
}): ResolvedAiRuntimeRequest {
  const baseRequest = buildAiChatRuntimeRequest(input);
  if (!input.resume) {
    return { runtimeRequest: baseRequest };
  }

  const checkpoint = getInterruptionCheckpointForResume({
    interruptionId: input.resume.interruptionId,
    userId: input.req.auth?.id || 'anonymous',
    conversationId: input.conversationId || undefined,
  });
  if (!checkpoint) {
    throw new ApiError(404, '未找到可恢复的中断状态。', 'INTERRUPTION_NOT_FOUND');
  }
  if (checkpoint.status !== 'awaiting_user') {
    throw new ApiError(409, '该中断状态已被处理，无法再次恢复。', 'INTERRUPTION_NOT_RESUMABLE');
  }

  const selectedOption = checkpoint.options.find((item) => item.id === input.resume?.optionId);
  if (!selectedOption) {
    throw new ApiError(400, '中断选项无效，无法恢复。', 'INTERRUPTION_OPTION_INVALID');
  }

  const effectivePrompt =
    input.resume.prompt?.trim() ||
    input.prompt.trim() ||
    selectedOption.prompt.trim() ||
    checkpoint.requestPrompt;
  const resumedPrompt = [
    `中断恢复：用户已确认上一轮选项「${selectedOption.label}」。`,
    '这项选择应视为已确认事实，除非与当前证据直接冲突，否则不要重复追问同一个问题。',
    '请基于已恢复的附件、上一轮识别结果和该选择，继续处理剩余主数据缺口或下一步导入动作。',
    `用户当前输入：${effectivePrompt}`,
  ].join('\n');
  // Use current attachments if provided; otherwise restore from checkpoint but
  // strip heavy base64 payload — the image was already processed in the first turn.
  const rawAttachments = input.attachments.length > 0 ? input.attachments : checkpoint.requestAttachments;
  const effectiveAttachments = rawAttachments.map((att) => {
    if (att.kind === 'image') {
      return { ...att, imageDataUrl: undefined, imageWidth: undefined, imageHeight: undefined };
    }
    return att;
  });
  const effectiveHistory = buildHistoryFromCheckpoint(checkpoint);

  const hasConversationMessages = !!(checkpoint.conversationMessages?.length);
  if (!hasConversationMessages) {
    console.warn('[resume] checkpoint has no conversationMessages — fallback to fresh context rebuild');
  } else {
    console.log(`[resume] restoring ${checkpoint.conversationMessages!.length} conversation messages from checkpoint`);
  }

  return {
    resumedCheckpoint: checkpoint,
    runtimeRequest: buildAiChatRuntimeRequest({
      ...input,
      prompt: resumedPrompt,
      conversationId: input.conversationId || checkpoint.conversationId,
      attachments: effectiveAttachments,
      history: effectiveHistory,
      ...(hasConversationMessages ? { conversationMessages: checkpoint.conversationMessages } : {}),
    }),
  };
}

export function persistInterruptionCheckpointResult(input: {
  result: AiChatResponse;
  runtimeRequest: AiChatRequest;
  resumedCheckpoint?: StoredInterruptionCheckpoint;
}) {
  if (input.resumedCheckpoint) {
    markInterruptionCheckpointResumed({
      interruptionId: input.resumedCheckpoint.id,
      resumeOptionId: input.runtimeRequest.resume?.optionId || 'resume',
      resumePrompt: input.runtimeRequest.prompt,
    });
    markInterruptionCheckpointResolved(input.resumedCheckpoint.id);
  }

  if (!input.result.interruption) {
    return;
  }

  const hasConvMsgs = !!(input.result.conversationMessages?.length);
  console.log(`[checkpoint-save] conversationMessages present: ${hasConvMsgs} (count=${input.result.conversationMessages?.length || 0})`);

  saveInterruptionCheckpoint({
    interruption: input.result.interruption,
    conversationId: input.runtimeRequest.conversationId || 'default',
    userId: input.runtimeRequest.userId,
    tenantId: input.runtimeRequest.tenantId,
    requestPrompt: input.runtimeRequest.prompt,
    requestAttachments: input.runtimeRequest.attachments || [],
    requestHistory: input.runtimeRequest.history || [],
    assistantReply: input.result.reply,
    assistantToolCalls: input.result.toolCalls || [],
    assistantPendingAction: input.result.pendingAction,
    conversationMessages: input.result.conversationMessages,
    parentInterruptionId: input.resumedCheckpoint?.id,
  });
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
    interruption: meta.interruption,
    note: meta.note,
    trace: meta.trace,
    conversationMessages: meta.conversationMessages,
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
