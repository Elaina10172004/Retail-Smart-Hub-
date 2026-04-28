import { db } from '../../database/db';
import type { AiDocumentAttachment } from './attachment-context.service';
import type { AiChatRequest, AiChatResponse, AiInterruption } from './ai.types';
import type { AiToolCallRecord } from './dto/tool.dto';

type InterruptionCheckpointStatus = 'awaiting_user' | 'resumed' | 'superseded' | 'resolved';

interface InterruptionCheckpointRow {
  id: string;
  conversationId: string;
  userId: string;
  tenantId: string | null;
  kind: string;
  status: InterruptionCheckpointStatus;
  title: string;
  message: string;
  optionsJson: string;
  requestPrompt: string;
  requestAttachmentsJson: string;
  requestHistoryJson: string;
  assistantReply: string;
  assistantToolCallsJson: string;
  assistantPendingActionJson: string | null;
  conversationMessagesJson: string;
  parentInterruptionId: string | null;
  resumeOptionId: string | null;
  resumePrompt: string | null;
  createdAt: string;
  updatedAt: string;
  resumedAt: string | null;
  resolvedAt: string | null;
}

export interface StoredInterruptionCheckpoint {
  id: string;
  conversationId: string;
  userId: string;
  tenantId?: string;
  kind: string;
  status: InterruptionCheckpointStatus;
  title: string;
  message: string;
  options: AiInterruption['options'];
  requestPrompt: string;
  requestAttachments: AiDocumentAttachment[];
  requestHistory: NonNullable<AiChatRequest['history']>;
  assistantReply: string;
  assistantToolCalls: AiToolCallRecord[];
  assistantPendingAction?: AiChatResponse['pendingAction'];
  conversationMessages?: Record<string, unknown>[];
  parentInterruptionId?: string;
  resumeOptionId?: string;
  resumePrompt?: string;
  createdAt: string;
  updatedAt: string;
  resumedAt?: string;
  resolvedAt?: string;
}

interface SaveInterruptionCheckpointInput {
  interruption: AiInterruption;
  conversationId: string;
  userId: string;
  tenantId?: string;
  requestPrompt: string;
  requestAttachments: AiDocumentAttachment[];
  requestHistory: NonNullable<AiChatRequest['history']>;
  assistantReply: string;
  assistantToolCalls: AiToolCallRecord[];
  assistantPendingAction?: AiChatResponse['pendingAction'];
  conversationMessages?: Record<string, unknown>[];
  parentInterruptionId?: string;
}

interface MarkInterruptionResumedInput {
  interruptionId: string;
  resumeOptionId: string;
  resumePrompt?: string;
}

interface ResolveInterruptionCheckpointInput {
  interruptionId: string;
  userId: string;
  conversationId?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonStringify(value: unknown, fallback = '[]') {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value || typeof value !== 'string') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function toCheckpoint(row: InterruptionCheckpointRow | undefined): StoredInterruptionCheckpoint | null {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    tenantId: row.tenantId || undefined,
    kind: row.kind,
    status: row.status,
    title: row.title,
    message: row.message,
    options: safeJsonParse(row.optionsJson, [] as AiInterruption['options']),
    requestPrompt: row.requestPrompt,
    requestAttachments: safeJsonParse(row.requestAttachmentsJson, [] as AiDocumentAttachment[]),
    requestHistory: safeJsonParse(row.requestHistoryJson, [] as NonNullable<AiChatRequest['history']>),
    assistantReply: row.assistantReply,
    assistantToolCalls: safeJsonParse(row.assistantToolCallsJson, [] as AiToolCallRecord[]),
    assistantPendingAction: safeJsonParse(row.assistantPendingActionJson, undefined as AiChatResponse['pendingAction'] | undefined),
    conversationMessages: safeJsonParse(row.conversationMessagesJson, undefined as Record<string, unknown>[] | undefined),
    parentInterruptionId: row.parentInterruptionId || undefined,
    resumeOptionId: row.resumeOptionId || undefined,
    resumePrompt: row.resumePrompt || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resumedAt: row.resumedAt || undefined,
    resolvedAt: row.resolvedAt || undefined,
  };
}

const getCheckpointById = db.prepare<InterruptionCheckpointRow>(`
  SELECT
    id,
    conversation_id as conversationId,
    user_id as userId,
    tenant_id as tenantId,
    kind,
    status,
    title,
    message,
    options_json as optionsJson,
    request_prompt as requestPrompt,
    request_attachments_json as requestAttachmentsJson,
    request_history_json as requestHistoryJson,
    assistant_reply as assistantReply,
    assistant_tool_calls_json as assistantToolCallsJson,
    assistant_pending_action_json as assistantPendingActionJson,
    conversation_messages_json as conversationMessagesJson,
    parent_interruption_id as parentInterruptionId,
    resume_option_id as resumeOptionId,
    resume_prompt as resumePrompt,
    created_at as createdAt,
    updated_at as updatedAt,
    resumed_at as resumedAt,
    resolved_at as resolvedAt
  FROM ai_interruption_checkpoints
  WHERE id = ?
`);

const upsertCheckpointStatement = db.prepare(`
  INSERT INTO ai_interruption_checkpoints (
    id, conversation_id, user_id, tenant_id, kind, status, title, message,
    options_json, request_prompt, request_attachments_json, request_history_json,
    assistant_reply, assistant_tool_calls_json, assistant_pending_action_json,
    conversation_messages_json,
    parent_interruption_id, resume_option_id, resume_prompt,
    created_at, updated_at, resumed_at, resolved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
  ON CONFLICT(id) DO UPDATE SET
    conversation_id = excluded.conversation_id,
    user_id = excluded.user_id,
    tenant_id = excluded.tenant_id,
    kind = excluded.kind,
    status = excluded.status,
    title = excluded.title,
    message = excluded.message,
    options_json = excluded.options_json,
    request_prompt = excluded.request_prompt,
    request_attachments_json = excluded.request_attachments_json,
    request_history_json = excluded.request_history_json,
    assistant_reply = excluded.assistant_reply,
    assistant_tool_calls_json = excluded.assistant_tool_calls_json,
    assistant_pending_action_json = excluded.assistant_pending_action_json,
    conversation_messages_json = excluded.conversation_messages_json,
    parent_interruption_id = excluded.parent_interruption_id,
    updated_at = excluded.updated_at
`);

const supersedeConversationInterruptionsStatement = db.prepare(`
  UPDATE ai_interruption_checkpoints
    SET status = 'superseded',
        updated_at = ?,
        resolved_at = COALESCE(resolved_at, ?)
  WHERE conversation_id = ?
    AND user_id = ?
    AND status IN ('awaiting_user', 'resumed')
    AND id <> ?
`);

const markCheckpointResumedStatement = db.prepare(`
  UPDATE ai_interruption_checkpoints
    SET status = 'resumed',
        resume_option_id = ?,
        resume_prompt = ?,
        resumed_at = ?,
        updated_at = ?
  WHERE id = ?
    AND status = 'awaiting_user'
`);

const markCheckpointResolvedStatement = db.prepare(`
  UPDATE ai_interruption_checkpoints
    SET status = 'resolved',
        updated_at = ?,
        resolved_at = COALESCE(resolved_at, ?)
  WHERE id = ?
    AND status IN ('awaiting_user', 'resumed')
`);

export function saveInterruptionCheckpoint(input: SaveInterruptionCheckpointInput) {
  const timestamp = nowIso();
  supersedeConversationInterruptionsStatement.run(
    timestamp,
    timestamp,
    input.conversationId,
    input.userId,
    input.interruption.id,
  );
  upsertCheckpointStatement.run(
    input.interruption.id,
    input.conversationId,
    input.userId,
    input.tenantId || null,
    input.interruption.kind,
    input.interruption.status,
    input.interruption.title,
    input.interruption.message,
    safeJsonStringify(input.interruption.options, '[]'),
    input.requestPrompt,
    safeJsonStringify(input.requestAttachments, '[]'),
    safeJsonStringify(input.requestHistory, '[]'),
    input.assistantReply,
    safeJsonStringify(input.assistantToolCalls, '[]'),
    input.assistantPendingAction ? safeJsonStringify(input.assistantPendingAction, 'null') : null,
    input.conversationMessages ? safeJsonStringify(input.conversationMessages, '[]') : '[]',
    input.parentInterruptionId || null,
    timestamp,
    timestamp,
  );
}

export function getInterruptionCheckpointForResume(input: ResolveInterruptionCheckpointInput) {
  const row = getCheckpointById.get(input.interruptionId);
  const checkpoint = toCheckpoint(row);
  if (!checkpoint) {
    return null;
  }
  if (checkpoint.userId !== input.userId) {
    return null;
  }
  if (input.conversationId && checkpoint.conversationId !== input.conversationId) {
    return null;
  }
  if (checkpoint.status !== 'awaiting_user') {
    return checkpoint;
  }
  return checkpoint;
}

export function markInterruptionCheckpointResumed(input: MarkInterruptionResumedInput) {
  const timestamp = nowIso();
  markCheckpointResumedStatement.run(
    input.resumeOptionId,
    input.resumePrompt || null,
    timestamp,
    timestamp,
    input.interruptionId,
  );
}

export function markInterruptionCheckpointResolved(interruptionId: string) {
  const timestamp = nowIso();
  markCheckpointResolvedStatement.run(timestamp, timestamp, interruptionId);
}
