import type { AiDocumentAttachment } from './attachment-context.service';
import type { AiApproval, AiPendingAction, AiToolCallRecord } from './dto/tool.dto';

export interface AiStatusPayload {
  configured: boolean;
  provider: string;
  model: string;
  ragEnabled: boolean;
  functionUseEnabled: boolean;
  apiKeyEnv: string;
}

export interface AiWebSource {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
  publishedDate?: string;
  score?: number;
}

export interface AiChatRequest {
  prompt: string;
  conversationId?: string;
  resume?: {
    interruptionId: string;
    optionId: string;
    prompt?: string;
  };
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
  conversationMessages?: Record<string, unknown>[];
}

export interface AiInterruptionOption {
  id: string;
  label: string;
  prompt: string;
  description?: string;
}

export interface AiInterruption {
  id: string;
  kind: 'clarification';
  status: 'awaiting_user';
  title: string;
  message: string;
  options: AiInterruptionOption[];
}

export interface AiChatResponse {
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
  interruption?: AiInterruption;
  reasoningContent?: string;
  configured: boolean;
  provider: string;
  model: string;
  note?: string;
  trace?: string[];
  conversationMessages?: Record<string, unknown>[];
}

export interface AiChatStreamMeta {
  toolCalls: AiToolCallRecord[];
  citations: string[];
  webSources?: AiWebSource[];
  answer_meta?: AiChatResponse['answer_meta'];
  pendingAction?: AiPendingAction;
  approval?: AiApproval;
  interruption?: AiInterruption;
  configured: boolean;
  provider: string;
  model: string;
  note?: string;
  trace?: string[];
  conversationMessages?: Record<string, unknown>[];
}

export interface AiChatStreamDelta {
  replyDelta?: string;
  reasoningDelta?: string;
}

export interface AiChatStreamCallbacks {
  onMeta?: (meta: AiChatStreamMeta) => void;
  onDelta?: (delta: AiChatStreamDelta) => void;
}
