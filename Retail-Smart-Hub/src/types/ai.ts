import type {
  AiApproval,
  AiPendingAction,
  AiToolCallRecord,
} from '../../server/src/modules/ai/dto/tool.dto';
import type { ImportSourceRow } from './import';

export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
  ragEnabled: boolean;
  functionUseEnabled: boolean;
  apiKeyEnv: string;
}

export type AiProvider = 'deepseek' | 'openai' | 'gemini';

export interface AiModelProfile {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

export interface AiSearchProviderProfile {
  provider: 'tavily';
  baseUrl: string;
  topic: 'general' | 'news';
  maxResults: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
  enabled: boolean;
}

export interface AiRuntimeConfig {
  provider: AiProvider;
  runtime: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  geminiBaseUrl: string;
  geminiModel: string;
  tavilyBaseUrl: string;
  tavilyTopic: 'general' | 'news';
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
  providerProfiles: Record<AiProvider, AiModelProfile>;
  smallRoleProvider: AiProvider;
  largeRoleProvider: AiProvider;
  smallModelProfile: AiModelProfile;
  largeModelProfile: AiModelProfile;
  tavilyProfile: AiSearchProviderProfile;
  layeredAgentEnabled: boolean;
  updatedAt?: string;
}

export interface AiKnowledgeDocumentSummary {
  key: string;
  relativePath: string;
  fileName: string;
  directory: string;
  extension: string;
  source: 'docs' | 'root';
  size: number;
  updatedAt: string;
  isRegisteredSource: boolean;
  includeInAssistant: boolean;
  docId?: string;
  docTitle?: string;
  sourceType?: string;
  moduleId?: string;
  scopeType?: string;
}

export interface AiKnowledgeDocumentDetail {
  document: AiKnowledgeDocumentSummary;
  content: string;
  lineCount: number;
}

export type AiMemoryScope = 'global' | 'tenant' | 'user' | 'session' | 'effective';
export type AiMemoryFactScope = 'user' | 'tenant' | 'session';

export interface AiProfileMemoryValue {
  assistantDisplayName?: string;
  assistantAliases?: string[];
  userPreferredName?: string;
  language?: string;
  stylePreferences?: string[];
}

export interface AiProfileMemoryPatch {
  assistantDisplayName?: string | null;
  assistantAliases?: string[] | null;
  userPreferredName?: string | null;
  language?: string | null;
  stylePreferences?: string[] | null;
}

export interface AiProfileMemoryRecord {
  id: string;
  scope: Exclude<AiMemoryScope, 'effective'>;
  scopeId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  profile: AiProfileMemoryValue;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastConfirmedAt?: string;
}

export interface AiMemoryProfileResponse {
  scope: AiMemoryScope;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  profile: AiProfileMemoryValue;
  records: AiProfileMemoryRecord[];
  version: number;
  updatedAt: string;
  updatedBy: string;
  lastConfirmedAt?: string;
  priorityOrder: Array<'session' | 'user' | 'tenant' | 'global'>;
  notes: string[];
}

export interface AiMemoryFact {
  id: string;
  userId: string;
  tenantId?: string;
  sessionId?: string;
  title: string;
  content: string;
  createdAt: string;
  tier: 'working' | 'episodic' | 'semantic' | 'archive';
  importance: number;
  reinforcedCount: number;
  lastAccessAt: string;
  lastReinforcedAt?: string;
  tags: string[];
}

export interface AiMemoryFactsResponse {
  scope: AiMemoryFactScope;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  limit: number;
  facts: AiMemoryFact[];
}

export type AiToolCall = AiToolCallRecord;
export type { AiApproval, AiPendingAction, AiToolCallRecord };

export interface AiChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: AiToolCall[];
  pendingActionId?: string;
  pendingActionName?: string;
  pendingActionStatus?: AiPendingAction['status'];
}

export interface AiChatRequest {
  prompt: string;
  conversationId?: string;
  history?: AiChatHistoryTurn[];
  attachments?: AiAttachmentDraft[];
}

export type AiImportTarget = 'auto' | 'customer' | 'product' | 'order';
export type AiAttachmentKind = 'document' | 'table' | 'workbook' | 'image';

export interface AiAttachmentLocator {
  attachmentId?: string;
  fileName?: string;
  kind?: AiAttachmentKind;
  page?: number;
  paragraph?: number;
  sectionTitle?: string;
  headingPath?: string[];
  blockId?: string;
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  columnStart?: number;
  columnEnd?: number;
  cellRange?: string;
  charStart?: number;
  charEnd?: number;
}

export interface AiAttachmentBlock {
  blockId: string;
  type: 'paragraph' | 'heading' | 'page' | 'sheet_summary' | 'table_summary';
  text: string;
  title?: string;
  locator: AiAttachmentLocator;
}

export interface AiAttachmentSheet {
  name: string;
  rowCount: number;
  headers: string[];
  rows: ImportSourceRow[];
}

export interface AiAttachmentDraft {
  id: string;
  fileName: string;
  target: AiImportTarget;
  kind: AiAttachmentKind;
  mimeType?: string;
  imageDataUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  rowCount: number;
  rows: ImportSourceRow[];
  sheetCount: number;
  sheets: AiAttachmentSheet[];
  textContent?: string;
  blocks: AiAttachmentBlock[];
  uploadedAt: string;
}

export interface AiChatResponse {
  reply: string;
  toolCalls: AiToolCall[];
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

export interface AiActionMutationResponse {
  reply: string;
  toolCall: AiToolCall;
  pendingAction: AiPendingAction;
  approval?: AiApproval;
  trace?: string[];
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  reasoningDurationMs?: number;
  meta?: string;
  citations?: string[];
  webSources?: AiWebSource[];
  toolCalls?: AiToolCall[];
  pendingAction?: AiPendingAction;
  trace?: string[];
  isSystem?: boolean;
}

export interface AiWebSource {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
  publishedDate?: string;
  score?: number;
}

export interface AiChatSession {
  id: string;
  title: string;
  draft: string;
  createdAt: string;
  updatedAt: string;
  messages: AiMessage[];
  attachments?: AiAttachmentDraft[];
}
