import { env } from '../../config/env';
import type { AiApproval, AiPendingAction, AiToolCallRecord } from './dto/tool.dto';
import type { AiDocumentAttachment } from './import.service';
import type { AiWebSource } from './ai.types';

interface PythonRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
}

export interface PythonAgentChatRequest {
  prompt: string;
  conversationId?: string;
  userId: string;
  tenantId?: string;
  username: string;
  roles: string[];
  permissions: string[];
  token: string;
  attachments?: AiDocumentAttachment[];
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: AiToolCallRecord[];
    pendingActionId?: string;
    pendingActionName?: string;
    pendingActionStatus?: AiPendingAction['status'];
  }>;
}

export interface PythonAgentChatResponse {
  reply: string;
  toolCalls: AiToolCallRecord[];
  citations: string[];
  webSources?: AiWebSource[];
  memoryCapture?: {
    captured: boolean;
    owner?: 'python' | 'node-backfill';
    reason?: string;
    error?: string;
  };
  answer_meta?: {
    used_evidence_ids: string[];
    unresolved_gaps: string[];
    confidence: 'low' | 'medium' | 'high';
    confidence_score: number;
  };
  pendingAction?: AiPendingAction;
  approval?: AiApproval;
  reasoningContent?: string;
  configured: boolean;
  provider: string;
  model: string;
  note?: string;
  trace?: string[];
}

export interface PythonAgentStreamMeta {
  toolCalls: AiToolCallRecord[];
  citations: string[];
  webSources?: AiWebSource[];
  answer_meta?: PythonAgentChatResponse['answer_meta'];
  pendingAction?: AiPendingAction;
  approval?: AiApproval;
  configured: boolean;
  provider: string;
  model: string;
  note?: string;
  trace?: string[];
}

export interface PythonAgentStreamCallbacks {
  onMeta?: (meta: PythonAgentStreamMeta) => void;
  onDelta?: (delta: { replyDelta?: string; reasoningDelta?: string }) => void;
}

function buildPythonAgentUrl(pathname: string) {
  return `http://${env.aiPythonHost}:${env.aiPythonPort}${pathname}`;
}

export function isPythonRuntimeEnabled() {
  return env.aiRuntime === 'python';
}

function extractPythonErrorMessage(payload: unknown) {
  if (payload && typeof payload === 'object') {
    if ('message' in payload && typeof (payload as { message?: unknown }).message === 'string') {
      const message = (payload as { message?: string }).message?.trim();
      if (message) {
        return message;
      }
    }

    if ('detail' in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.trim()) {
        return detail.trim();
      }
      if (detail && typeof detail === 'object' && 'message' in detail && typeof (detail as { message?: unknown }).message === 'string') {
        const message = (detail as { message?: string }).message?.trim();
        if (message) {
          return message;
        }
      }
      try {
        return JSON.stringify(detail);
      } catch {
        return '';
      }
    }
  }

  if (typeof payload === 'string') {
    return payload.trim();
  }

  return '';
}

function isAbortLikeError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR') {
    return true;
  }
  if (typeof candidate.message === 'string') {
    const normalized = candidate.message.toLowerCase();
    return normalized.includes('aborted') || normalized.includes('aborterror');
  }
  return false;
}

async function pythonRequest<T>(pathname: string, options: PythonRequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs || env.aiAgentRequestTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(buildPythonAgentUrl(pathname), {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-key': env.aiAgentSharedKey,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw new Error(`[python-agent ${pathname}] request timeout after ${timeoutMs}ms`);
      }
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const message = extractPythonErrorMessage(payload);
      throw new Error(message || `[python-agent ${pathname}] request failed: ${response.status}`);
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPythonAgentStatus(token: string) {
  return pythonRequest<{
    configured: boolean;
    provider: string;
    model: string;
    ragEnabled: boolean;
    functionUseEnabled: boolean;
    apiKeyEnv: string;
  }>('/internal/agent/status', {
    method: 'POST',
    body: { token },
  });
}

export async function generateAiReplyViaPython(input: PythonAgentChatRequest) {
  return pythonRequest<PythonAgentChatResponse>('/internal/agent/chat', {
    method: 'POST',
    body: input,
  });
}

function parseSseEventsChunk(buffer: string) {
  const events: Array<{ event: string; data: string }> = [];
  let remainder = buffer;

  while (true) {
    const lfBoundary = remainder.indexOf('\n\n');
    const crlfBoundary = remainder.indexOf('\r\n\r\n');
    const hasCrLf = crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary);
    const boundary = hasCrLf ? crlfBoundary : lfBoundary;
    const delimiterLength = hasCrLf ? 4 : 2;
    if (boundary < 0) {
      break;
    }

    const block = remainder.slice(0, boundary);
    remainder = remainder.slice(boundary + delimiterLength);
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    events.push({
      event: eventName,
      data: dataLines.join('\n'),
    });
  }

  return {
    events,
    remainder,
  };
}

function parseMaybeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function streamAiReplyViaPython(
  input: PythonAgentChatRequest,
  callbacks: PythonAgentStreamCallbacks = {},
): Promise<PythonAgentChatResponse> {
  const timeoutMs = env.aiAgentRequestTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let finalResponse: PythonAgentChatResponse | null = null;

  try {
    let response: Response;
    try {
      response = await fetch(buildPythonAgentUrl('/internal/agent/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-key': env.aiAgentSharedKey,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw new Error(`[python-agent /internal/agent/chat/stream] request timeout after ${timeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const rawError = await response.text();
      const parsedError = parseMaybeJson<{ message?: string; detail?: unknown }>(rawError);
      const message = parsedError ? extractPythonErrorMessage(parsedError) : rawError.trim();
      throw new Error(message || `[python-agent /internal/agent/chat/stream] request failed: ${response.status}`);
    }
    if (!response.body) {
      throw new Error('Python stream response body is empty');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = '';

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      remainder += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseEventsChunk(remainder);
      remainder = parsed.remainder;

      for (const item of parsed.events) {
        if (!item.data) {
          continue;
        }
        let data: unknown = null;
        try {
          data = JSON.parse(item.data);
        } catch {
          data = null;
        }

        if (item.event === 'meta' && data && typeof data === 'object') {
          callbacks.onMeta?.(data as PythonAgentStreamMeta);
          continue;
        }
        if (item.event === 'delta' && data && typeof data === 'object') {
          callbacks.onDelta?.(data as { replyDelta?: string; reasoningDelta?: string });
          continue;
        }
        if (item.event === 'done' && data && typeof data === 'object') {
          finalResponse = data as PythonAgentChatResponse;
          continue;
        }
        if (item.event === 'error') {
          const message = extractPythonErrorMessage(data);
          throw new Error(message || 'Python stream returned error event');
        }
      }
    }

    if (!finalResponse) {
      throw new Error('Stream ended without final response');
    }
    return finalResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPythonRagStatus() {
  return pythonRequest<{
    chunkCount: number;
    lancedb: {
      enabled: boolean;
      available: boolean;
      tableName: string;
    };
  }>('/internal/agent/rag/status');
}

export async function getPythonRagDiagnostics() {
  return pythonRequest<Record<string, unknown>>('/internal/agent/rag/diagnostics');
}

export async function rebuildPythonRag(input: { force: boolean; incremental: boolean }) {
  return pythonRequest<{
    chunkCount: number;
    lancedbEnabled: boolean;
    lancedbAvailable: boolean;
    lancedbError?: string;
    rebuiltAt: string;
  }>('/internal/agent/rag/rebuild', {
    method: 'POST',
    body: input,
  });
}

export async function getPythonMemoryProfile(query: {
  token: string;
  scope: 'effective' | 'global' | 'tenant' | 'user' | 'session';
  tenantId?: string;
  userId?: string;
  sessionId?: string;
}) {
  return pythonRequest<Record<string, unknown>>('/internal/agent/memory/profile', {
    method: 'POST',
    body: query,
  });
}

export async function getPythonMemoryFacts(query: {
  token: string;
  scope: 'user' | 'tenant' | 'session';
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  limit: number;
}) {
  return pythonRequest<Record<string, unknown>>('/internal/agent/memory/facts', {
    method: 'POST',
    body: query,
  });
}

export async function patchPythonMemoryProfile(input: {
  token: string;
  scope: 'global' | 'tenant' | 'user' | 'session';
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  patch: Record<string, unknown>;
  updatedBy: string;
}) {
  return pythonRequest<Record<string, unknown>>('/internal/agent/memory/profile/patch', {
    method: 'POST',
    body: input,
  });
}

export async function deletePythonMemoryFact(input: {
  token: string;
  id: string;
  scope: 'user' | 'tenant' | 'session';
  tenantId?: string;
  userId?: string;
  sessionId?: string;
}) {
  return pythonRequest<Record<string, unknown>>('/internal/agent/memory/facts/delete', {
    method: 'POST',
    body: input,
  });
}
