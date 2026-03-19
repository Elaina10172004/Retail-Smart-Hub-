import { API_BASE_URL, apiClient, getAuthToken } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  AiActionMutationResponse,
  AiChatRequest,
  AiChatResponse,
  AiKnowledgeDocumentDetail,
  AiKnowledgeDocumentSummary,
  AiMemoryFactScope,
  AiMemoryFactsResponse,
  AiMemoryProfileResponse,
  AiMemoryScope,
  AiProfileMemoryPatch,
  AiPendingAction,
  AiRuntimeConfig,
  AiStatus,
} from '@/types/ai';

export interface AiChatStreamMeta {
  toolCalls: AiChatResponse['toolCalls'];
  citations: AiChatResponse['citations'];
  webSources?: AiChatResponse['webSources'];
  answer_meta?: AiChatResponse['answer_meta'];
  pendingAction?: AiChatResponse['pendingAction'];
  approval?: AiChatResponse['approval'];
  configured: AiChatResponse['configured'];
  provider: AiChatResponse['provider'];
  model: AiChatResponse['model'];
  note?: AiChatResponse['note'];
  trace?: AiChatResponse['trace'];
}

export interface AiChatStreamDelta {
  replyDelta?: string;
  reasoningDelta?: string;
}

export interface AiChatStreamHandlers {
  onMeta?: (meta: AiChatStreamMeta) => void;
  onDelta?: (delta: AiChatStreamDelta) => void;
}

export function fetchAiStatus() {
  return apiClient.get<ApiEnvelope<AiStatus>>('/ai/status');
}

export function sendAiChat(payload: AiChatRequest) {
  return apiClient.post<ApiEnvelope<AiChatResponse>>('/ai/chat', payload);
}

export function fetchAiRuntimeConfig() {
  return apiClient.get<ApiEnvelope<AiRuntimeConfig>>('/ai/config');
}

export function patchAiRuntimeConfig(payload: {
  provider?: 'deepseek' | 'openai' | 'gemini';
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
  tavilyTopic?: 'general' | 'news';
  tavilyMaxResults?: number;
  smallProvider?: 'deepseek' | 'openai' | 'gemini';
  smallApiKey?: string | null;
  smallBaseUrl?: string;
  smallModel?: string;
  largeProvider?: 'deepseek' | 'openai' | 'gemini';
  largeApiKey?: string | null;
  largeBaseUrl?: string;
  largeModel?: string;
  layeredAgentEnabled?: boolean;
}) {
  return apiClient.patch<ApiEnvelope<AiRuntimeConfig>>('/ai/config', payload);
}

export function fetchAiKnowledgeDocuments() {
  return apiClient.get<ApiEnvelope<{ count: number; documents: AiKnowledgeDocumentSummary[] }>>('/ai/rag/documents');
}

export function fetchAiKnowledgeDocumentByKey(key: string) {
  return apiClient.get<ApiEnvelope<AiKnowledgeDocumentDetail>>(`/ai/rag/documents/${encodeURIComponent(key)}`);
}

export function patchAiKnowledgeDocumentByKey(key: string, payload: { content?: string; includeInAssistant?: boolean }) {
  return apiClient.patch<ApiEnvelope<{ document: AiKnowledgeDocumentSummary; lineCount: number }>>(
    `/ai/rag/documents/${encodeURIComponent(key)}`,
    payload,
  );
}

export function uploadAiKnowledgeDocument(payload: {
  fileName: string;
  content: string;
  targetDir?: string;
  overwrite?: boolean;
  includeInAssistant?: boolean;
}) {
  return apiClient.post<ApiEnvelope<{ document: AiKnowledgeDocumentSummary; lineCount: number }>>(
    '/ai/rag/documents/upload',
    payload,
  );
}

export function deleteAiKnowledgeDocumentByKey(key: string) {
  return apiClient.delete<ApiEnvelope<{ deleted: boolean; relativePath: string }>>(
    `/ai/rag/documents/${encodeURIComponent(key)}`,
  );
}

function buildQueryString(
  params: Record<string, string | number | undefined>,
) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    const text = String(value).trim();
    if (!text) {
      return;
    }
    search.set(key, text);
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function fetchAiMemoryProfile(input: {
  scope?: AiMemoryScope;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
} = {}) {
  const query = buildQueryString({
    scope: input.scope,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  return apiClient.get<ApiEnvelope<AiMemoryProfileResponse>>(`/ai/memory/profile${query}`);
}

export function fetchAiMemoryFacts(input: {
  scope?: AiMemoryFactScope;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  limit?: number;
} = {}) {
  const query = buildQueryString({
    scope: input.scope,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
    limit: input.limit,
  });
  return apiClient.get<ApiEnvelope<AiMemoryFactsResponse>>(`/ai/memory/facts${query}`);
}

export function patchAiMemoryProfile(payload: {
  scope?: Exclude<AiMemoryScope, 'effective'>;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  patch: AiProfileMemoryPatch;
}) {
  return apiClient.patch<ApiEnvelope<AiMemoryProfileResponse>>('/ai/memory/profile', payload);
}

export function deleteAiMemoryFact(
  factId: string,
  input: {
    scope?: AiMemoryFactScope;
    tenantId?: string;
    userId?: string;
    sessionId?: string;
  } = {},
) {
  const query = buildQueryString({
    scope: input.scope,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  return apiClient.delete<ApiEnvelope<{ deleted: boolean; id?: string; reason?: string }>>(
    `/ai/memory/facts/${encodeURIComponent(factId)}${query}`,
  );
}

function parseSseBlock(block: string) {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  lines.forEach((line) => {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      return;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  });

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n'),
  };
}

function parseMaybeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractApiLikeErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const parsed = payload as {
    message?: unknown;
    detail?: unknown;
  };

  if (typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim();
  }

  if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
    return parsed.detail.trim();
  }

  if (parsed.detail && typeof parsed.detail === 'object') {
    const detailObject = parsed.detail as { message?: unknown };
    if (typeof detailObject.message === 'string' && detailObject.message.trim()) {
      return detailObject.message.trim();
    }
    try {
      return JSON.stringify(parsed.detail);
    } catch {
      return '';
    }
  }

  return '';
}

export async function streamAiChat(payload: AiChatRequest, handlers: AiChatStreamHandlers = {}) {
  const authToken = getAuthToken();
  const response = await fetch(`${API_BASE_URL}/ai/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const rawBody = await response.text();
    const parsed = parseMaybeJson<{ message?: unknown; detail?: unknown }>(rawBody);
    const reason =
      extractApiLikeErrorMessage(parsed) || rawBody.trim() || response.statusText || 'Request failed';
    throw new Error(`POST /ai/chat/stream -> ${response.status} ${reason}`);
  }

  if (!response.body) {
    throw new Error('Stream body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalResponse: AiChatResponse | null = null;
  let lastMeta: AiChatStreamMeta | null = null;
  let replyText = '';
  let reasoningText = '';
  let streamErrorMessage = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const lfBoundary = buffer.indexOf('\n\n');
      const crlfBoundary = buffer.indexOf('\r\n\r\n');
      const hasCrLf = crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary);
      const boundary = hasCrLf ? crlfBoundary : lfBoundary;
      const delimiterLength = hasCrLf ? 4 : 2;
      if (boundary === -1) {
        break;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + delimiterLength);
      const parsed = parseSseBlock(block);
      if (!parsed) {
        continue;
      }

      if (parsed.event === 'keepalive') {
        continue;
      }

      if (parsed.event === 'meta') {
        const meta = parseMaybeJson<AiChatStreamMeta>(parsed.data);
        if (meta) {
          lastMeta = meta;
          handlers.onMeta?.(meta);
        }
        continue;
      }

      if (parsed.event === 'delta') {
        const delta = parseMaybeJson<AiChatStreamDelta>(parsed.data);
        if (delta) {
          if (typeof delta.replyDelta === 'string') {
            replyText += delta.replyDelta;
          }
          if (typeof delta.reasoningDelta === 'string') {
            reasoningText += delta.reasoningDelta;
          }
          handlers.onDelta?.(delta);
        }
        continue;
      }

      if (parsed.event === 'error') {
        const errorPayload = parseMaybeJson<{ message?: unknown; detail?: unknown }>(parsed.data);
        const message = extractApiLikeErrorMessage(errorPayload) || parsed.data.trim() || 'AI stream failed';
        if (!lastMeta && !replyText && !reasoningText) {
          throw new Error(message);
        }
        streamErrorMessage = message;
        continue;
      }

      if (parsed.event === 'done') {
        const donePayload = parseMaybeJson<AiChatResponse>(parsed.data);
        if (donePayload) {
          finalResponse = donePayload;
        }
      }
    }
  }

  if (finalResponse) {
    if (streamErrorMessage) {
      const warning = `流式尾部异常：${streamErrorMessage}`;
      const trace = Array.isArray(finalResponse.trace) ? [...finalResponse.trace] : [];
      trace.push(warning);
      finalResponse.note = finalResponse.note ? `${finalResponse.note} | ${warning}` : warning;
      finalResponse.trace = trace;
    }
    return finalResponse;
  }

  const trailing = parseSseBlock(buffer.trim());
  if (trailing?.event === 'done') {
    const donePayload = parseMaybeJson<AiChatResponse>(trailing.data);
    if (donePayload) {
      return donePayload;
    }
  }

  if (lastMeta || replyText || reasoningText) {
    const warning = streamErrorMessage ? `流式尾部异常：${streamErrorMessage}` : '';
    const trace = Array.isArray(lastMeta?.trace) ? [...lastMeta.trace] : [];
    if (warning) {
      trace.push(warning);
    }
    const note = [lastMeta?.note, warning].filter(Boolean).join(' | ');

    return {
      reply: replyText.trim() || '模型流式回复已结束。',
      reasoningContent: reasoningText.trim() || undefined,
      toolCalls: lastMeta?.toolCalls || [],
      citations: lastMeta?.citations || [],
      webSources: lastMeta?.webSources,
      answer_meta: lastMeta?.answer_meta,
      pendingAction: lastMeta?.pendingAction,
      approval: lastMeta?.approval,
      configured: lastMeta?.configured ?? true,
      provider: lastMeta?.provider || 'deepseek',
      model: lastMeta?.model || 'deepseek-stream',
      note: note || undefined,
      trace: trace.length > 0 ? trace : undefined,
    };
  }

  if (streamErrorMessage) {
    throw new Error(streamErrorMessage);
  }

  throw new Error('Stream ended without final response');
}

export function confirmAiAction(actionId: string) {
  return apiClient.post<ApiEnvelope<AiActionMutationResponse>>(`/ai/actions/${actionId}/confirm`, {});
}

export function cancelAiAction(actionId: string) {
  return apiClient.post<ApiEnvelope<AiActionMutationResponse>>(`/ai/actions/${actionId}/cancel`, {});
}

export function undoAiAction(actionId: string) {
  return apiClient.post<ApiEnvelope<AiActionMutationResponse>>(`/ai/actions/${actionId}/undo`, {});
}

export function fetchAiAction(actionId: string) {
  return apiClient.get<ApiEnvelope<AiPendingAction>>(`/ai/actions/${actionId}`);
}

