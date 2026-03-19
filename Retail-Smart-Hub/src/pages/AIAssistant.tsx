import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfirmDialog } from '@/components/ui/use-confirm-dialog';
import { parseAttachmentFile } from '@/lib/import';
import {
  cancelAiAction,
  confirmAiAction,
  fetchAiAction,
  sendAiChat,
  fetchAiStatus,
  streamAiChat,
  type AiChatStreamMeta,
  undoAiAction,
} from '@/services/api/ai';
import type {
  AiAttachmentDraft,
  AiChatSession,
  AiImportTarget,
  AiMessage,
  AiPendingAction,
  AiStatus,
  AiToolCall,
  AiWebSource,
} from '@/types/ai';
import { AI_GREETING_CANDIDATES, AI_SESSION_UPDATE_EVENT } from './ai-assistant.constants';

const quickPrompts = [
  '这个系统目前已经完成了哪些核心业务模块？',
  '帮我看一下仪表盘概览。',
  '帮我看最近到货记录。',
  '帮我查一下到货单 RCV-20260311-001 的详情。',
  '帮我看待入库单。',
  '帮我查一下入库单 INB-20260311-001 的详情。',
  '帮我查一下发货单 SHP-20260311-001。',
  '帮我看一下采购建议。',
  '帮我看一下 SKU-1001 的库存详情。',
  '帮我查一下采购单 PO-20260311-001 的详情。',
  '帮我看一下财务概览。',
  '帮我看应收单 AR-20260311-001 的详情。',
  '帮我看最近 3 条收款记录。',
  '帮我查一下客户档案。',
  '帮我看一下客户 CUS-001 的详情。',
  '帮我看一下权限与角色概览。',
  '帮我看一下基础资料概览。',
  '帮我看一下当前密码策略。',
  '帮我看一下我的会话安全状态。',
  '累计销售额的统计口径是什么？',
  '当前财务模块有哪些接口？',
  '帮我看一下 sales_orders 表结构。',
  '当前系统有哪些角色模板？',
  '系统里的高风险操作分级是什么？',
  '审计日志的记录口径是什么？',
  '创建订单 客户 朝阳社区店 渠道 门店补货',
  '帮我看一下消息中心有哪些待处理提醒。',
  '帮我看最近 5 条审计日志。',
  '帮我生成低库存补货采购单。',
  '创建客户 华东便利店 渠道 门店补货 联系人 张三 电话 13800001234',
  '创建商品 SKU SKU-2001 商品 维达湿巾 品类 纸品日化 单位 件 安全库存 30 售价 12.8 成本价 8.5 供应商 维达集团',
  '确认入库单 INB-20260311-001',
  '确认发货单 SHP-20260311-001',
  '登记收款 AR-20260311-001 金额 120',
  '登记付款 AP-20260310-001 金额 300',
  '创建订单 客户 朝阳社区店 渠道 门店补货 交付日期 2026-03-20 明细 SKU-1001*2, SKU-1002*1',
  '把刚才的交付日期改成 2026-03-22',
];

const AI_STREAM_TASKS = new Set<string>();

interface StoredAiSessions {
  activeSessionId: string;
  sessions: AiChatSession[];
}

function getStreamTaskKey(storageKey: string, sessionId: string) {
  return `${storageKey}::${sessionId}`;
}

function emitAiSessionUpdate(storageKey: string) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(AI_SESSION_UPDATE_EVENT, {
      detail: {
        storageKey,
      },
    }),
  );
}

function isAiSessionStreaming(storageKey: string, sessionId: string) {
  return AI_STREAM_TASKS.has(getStreamTaskKey(storageKey, sessionId));
}

function readStoredAiSessions(storageKey: string): StoredAiSessions | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const rawValue = window.localStorage.getItem(storageKey);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as { sessions?: unknown[]; activeSessionId?: string };
    const restoredSessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .map((item, index) => sanitizeSession(item, index))
          .filter((item): item is AiChatSession => Boolean(item))
      : [];

    if (restoredSessions.length === 0) {
      return null;
    }

    const restoredActiveId =
      typeof parsed.activeSessionId === 'string' &&
      restoredSessions.some((session) => session.id === parsed.activeSessionId)
        ? parsed.activeSessionId
        : restoredSessions[0].id;

    return {
      activeSessionId: restoredActiveId,
      sessions: restoredSessions,
    };
  } catch {
    return null;
  }
}

function writeStoredAiSessions(storageKey: string, payload: StoredAiSessions, emit = false) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(payload));
  if (emit) {
    emitAiSessionUpdate(storageKey);
  }
}

function mutateStoredAiSessions(
  storageKey: string,
  updater: (current: StoredAiSessions) => StoredAiSessions,
): StoredAiSessions | null {
  const current = readStoredAiSessions(storageKey);
  if (!current) {
    return null;
  }

  const next = updater(current);
  writeStoredAiSessions(storageKey, next, true);
  return next;
}

function nextClientId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createWelcomeMessage(): AiMessage {
  const index = Math.floor(Math.random() * AI_GREETING_CANDIDATES.length);
  return {
    id: nextClientId('assistant-welcome'),
    role: 'assistant',
    content: AI_GREETING_CANDIDATES[index],
    meta: '本地欢迎语',
    isSystem: true,
  };
}

function createSession(title = '新对话'): AiChatSession {
  const timestamp = new Date().toISOString();
  return {
    id: nextClientId('chat'),
    title,
    draft: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [createWelcomeMessage()],
    attachments: [],
  };
}

function buildMeta(status: AiStatus | null) {
  if (!status) {
    return '正在读取模型状态';
  }

  if (!status.configured) {
    return `待配置 ${status.apiKeyEnv}`;
  }

  return `${status.provider} / ${status.model}`;
}

function formatReasoningSeconds(durationMs?: number) {
  const normalizedMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1000;
  return Math.max(1, Math.round(normalizedMs / 1000));
}

function formatDateTime(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return timestamp.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSourceDomain(value?: string) {
  if (!value) {
    return '外部来源';
  }

  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function formatSourcePublishedDate(value?: string) {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
}

function mergeToolCalls(current: AiToolCall[] | undefined, nextCall: AiToolCall) {
  const existing = current ?? [];
  const index = existing.findIndex((item) => item.name === nextCall.name);
  if (index === -1) {
    return [...existing, nextCall];
  }

  return existing.map((item, itemIndex) => (itemIndex === index ? nextCall : item));
}

function normalizePendingAction(action: AiPendingAction): AiPendingAction {
  if (action.status === 'pending' && action.expiresAt < new Date().toISOString()) {
    return {
      ...action,
      status: 'expired',
    };
  }

  return action;
}

function sanitizeMessage(raw: unknown): AiMessage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const message = raw as Partial<AiMessage>;
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }

  if (typeof message.content !== 'string') {
    return null;
  }

  return {
    id: typeof message.id === 'string' && message.id ? message.id : nextClientId(`message-${message.role}`),
    role: message.role,
    content: message.content,
    reasoningContent: typeof message.reasoningContent === 'string' ? message.reasoningContent : undefined,
    reasoningDurationMs:
      typeof message.reasoningDurationMs === 'number' && Number.isFinite(message.reasoningDurationMs)
        ? message.reasoningDurationMs
        : undefined,
    meta: typeof message.meta === 'string' ? message.meta : undefined,
    citations: Array.isArray(message.citations) ? message.citations.filter((item): item is string => typeof item === 'string') : undefined,
    webSources: sanitizeWebSources(message.webSources),
    toolCalls: Array.isArray(message.toolCalls)
      ? message.toolCalls.filter(
          (item): item is AiToolCall =>
            Boolean(item) &&
            typeof item.name === 'string' &&
            typeof item.summary === 'string' &&
            ['planned', 'disabled', 'completed', 'awaiting_confirmation', 'cancelled', 'reverted'].includes(item.status),
        )
      : undefined,
    pendingAction:
      message.pendingAction &&
      typeof message.pendingAction.id === 'string' &&
      typeof message.pendingAction.name === 'string' &&
      typeof message.pendingAction.summary === 'string' &&
      typeof message.pendingAction.confirmationMessage === 'string' &&
      ['pending', 'confirmed', 'cancelled', 'undone', 'expired'].includes(message.pendingAction.status)
        ? normalizePendingAction({
            id: message.pendingAction.id,
            name: message.pendingAction.name,
            summary: message.pendingAction.summary,
            confirmationMessage: message.pendingAction.confirmationMessage,
            status: message.pendingAction.status,
            createdAt: typeof message.pendingAction.createdAt === 'string' ? message.pendingAction.createdAt : new Date().toISOString(),
            expiresAt: typeof message.pendingAction.expiresAt === 'string' ? message.pendingAction.expiresAt : new Date().toISOString(),
            canUndo: Boolean(message.pendingAction.canUndo),
            undoneAt: typeof message.pendingAction.undoneAt === 'string' ? message.pendingAction.undoneAt : undefined,
          })
        : undefined,
    trace: Array.isArray(message.trace) ? message.trace.filter((item): item is string => typeof item === 'string') : undefined,
    isSystem: Boolean(message.isSystem),
  };
}

function sanitizeWebSources(raw: unknown): AiWebSource[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const normalized = raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Partial<AiWebSource>;
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      const snippet = typeof candidate.snippet === 'string' ? candidate.snippet.trim() : '';
      if (!title && !url && !snippet) {
        return null;
      }

      return {
        title: title || url || '外部来源',
        url,
        snippet: snippet || undefined,
        sourceType: typeof candidate.sourceType === 'string' && candidate.sourceType.trim() ? candidate.sourceType.trim() : undefined,
        publishedDate:
          typeof candidate.publishedDate === 'string' && candidate.publishedDate.trim()
            ? candidate.publishedDate.trim()
            : undefined,
        score:
          typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : undefined,
      } satisfies AiWebSource;
    })
    .filter(Boolean) as AiWebSource[];

  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeAttachmentRows(
  rows: unknown,
): AiAttachmentDraft['rows'] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.filter(
    (row): row is AiAttachmentDraft['rows'][number] => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
}

function sanitizeAttachmentSheets(
  sheets: unknown,
): AiAttachmentDraft['sheets'] {
  if (!Array.isArray(sheets)) {
    return [];
  }

  return sheets
    .map((sheet) => {
      if (!sheet || typeof sheet !== 'object') {
        return null;
      }

      const candidate = sheet as Partial<AiAttachmentDraft['sheets'][number]>;
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      if (!name) {
        return null;
      }

      const rows = sanitizeAttachmentRows(candidate.rows);
      const rowCount =
        typeof candidate.rowCount === 'number' && Number.isFinite(candidate.rowCount) && candidate.rowCount >= 0
          ? candidate.rowCount
          : rows.length;

      return {
        name,
        rowCount,
        headers: Array.isArray(candidate.headers)
          ? candidate.headers.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
          : [],
        rows,
      } satisfies AiAttachmentDraft['sheets'][number];
    })
    .filter(Boolean) as AiAttachmentDraft['sheets'];
}

function sanitizeAttachmentBlocks(
  blocks: unknown,
): AiAttachmentDraft['blocks'] {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map((block, index) => {
      if (!block || typeof block !== 'object') {
        return null;
      }

      const candidate = block as Partial<AiAttachmentDraft['blocks'][number]>;
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      if (!text) {
        return null;
      }

      const type =
        candidate.type === 'heading' ||
        candidate.type === 'page' ||
        candidate.type === 'sheet_summary' ||
        candidate.type === 'table_summary'
          ? candidate.type
          : 'paragraph';
      const locator =
        candidate.locator && typeof candidate.locator === 'object' && !Array.isArray(candidate.locator)
          ? candidate.locator
          : {};

      return {
        blockId:
          typeof candidate.blockId === 'string' && candidate.blockId.trim()
            ? candidate.blockId.trim()
            : `attachment-block-${index + 1}`,
        type,
        text,
        title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : undefined,
        locator,
      } satisfies AiAttachmentDraft['blocks'][number];
    })
    .filter(Boolean) as AiAttachmentDraft['blocks'];
}

function flattenSheetRows(sheets: AiAttachmentDraft['sheets']) {
  return sheets.flatMap((sheet) =>
    sheet.rows.map((row) => ({
      ...row,
      sheetName: typeof row.sheetName === 'string' && row.sheetName ? row.sheetName : sheet.name,
    })),
  );
}

function describeAttachment(item: AiAttachmentDraft) {
  if (item.kind === 'image') {
    if (typeof item.imageWidth === 'number' && typeof item.imageHeight === 'number') {
      return `${item.imageWidth}x${item.imageHeight} 图片`;
    }
    return '图片';
  }

  if (item.kind === 'workbook') {
    return `${item.sheetCount} sheets / ${item.rowCount} rows`;
  }

  if (item.kind === 'table') {
    return `${item.rowCount} 行`;
  }

  const pageCount = item.blocks.filter((block) => block.type === 'page').length;
  if (pageCount > 0) {
    return `${pageCount} 页文档`;
  }

  if (item.blocks.length > 0) {
    return `${item.blocks.length} 段文档块`;
  }

  if (item.textContent) {
    return `${item.textContent.length} 字`;
  }

  return '文档';
}

function sanitizeSession(raw: unknown, index: number): AiChatSession | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const session = raw as Partial<AiChatSession>;
  const messages = Array.isArray(session.messages)
    ? session.messages.map((item) => sanitizeMessage(item)).filter((item): item is AiMessage => Boolean(item))
    : [];
  const title =
    typeof session.title === 'string' && session.title.trim()
      ? session.title.trim()
      : `新对话 ${index + 1}`;
  const attachments = Array.isArray(session.attachments)
    ? session.attachments
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }

          const attachment = item as Partial<AiAttachmentDraft>;
          if (typeof attachment.fileName !== 'string' || !attachment.fileName.trim()) {
            return null;
          }

          const safeRows = sanitizeAttachmentRows(attachment.rows);
          const safeSheets = sanitizeAttachmentSheets(attachment.sheets);
          const safeBlocks = sanitizeAttachmentBlocks(attachment.blocks);
          const sheetRows = flattenSheetRows(safeSheets);
          const effectiveRows = safeRows.length > 0 ? safeRows : sheetRows;
          const safeTextContent =
            typeof attachment.textContent === 'string' && attachment.textContent.trim()
              ? attachment.textContent.trim()
              : undefined;
          const safeImageDataUrl =
            typeof attachment.imageDataUrl === 'string' && attachment.imageDataUrl.trim()
              ? attachment.imageDataUrl.trim()
              : undefined;

          const kind =
            attachment.kind === 'document' ||
            attachment.kind === 'table' ||
            attachment.kind === 'workbook' ||
            attachment.kind === 'image'
              ? attachment.kind
              : safeImageDataUrl
                ? 'image'
                : safeSheets.length > 1
                ? 'workbook'
                : effectiveRows.length > 0
                  ? 'table'
                  : 'document';

          if (effectiveRows.length === 0 && safeBlocks.length === 0 && !safeTextContent && !safeImageDataUrl) {
            return null;
          }

          const target =
            attachment.target === 'customer' || attachment.target === 'product' || attachment.target === 'order'
              ? attachment.target
              : 'auto';

          return {
            id: typeof attachment.id === 'string' && attachment.id ? attachment.id : nextClientId('attachment'),
            fileName: attachment.fileName.trim(),
            target,
            kind,
            mimeType: typeof attachment.mimeType === 'string' && attachment.mimeType.trim() ? attachment.mimeType.trim() : undefined,
            imageDataUrl: safeImageDataUrl,
            imageWidth:
              typeof attachment.imageWidth === 'number' && Number.isFinite(attachment.imageWidth) && attachment.imageWidth > 0
                ? attachment.imageWidth
                : undefined,
            imageHeight:
              typeof attachment.imageHeight === 'number' && Number.isFinite(attachment.imageHeight) && attachment.imageHeight > 0
                ? attachment.imageHeight
                : undefined,
            rowCount:
              typeof attachment.rowCount === 'number' && Number.isFinite(attachment.rowCount) && attachment.rowCount > 0
                ? attachment.rowCount
                : effectiveRows.length,
            rows: effectiveRows,
            sheetCount:
              typeof attachment.sheetCount === 'number' && Number.isFinite(attachment.sheetCount) && attachment.sheetCount >= 0
                ? attachment.sheetCount
                : safeSheets.length,
            sheets: safeSheets,
            textContent: safeTextContent,
            blocks: safeBlocks,
            uploadedAt:
              typeof attachment.uploadedAt === 'string' && attachment.uploadedAt
                ? attachment.uploadedAt
                : new Date().toISOString(),
          } satisfies AiAttachmentDraft;
        })
        .filter(Boolean) as AiAttachmentDraft[]
    : [];

  return {
    id: typeof session.id === 'string' && session.id ? session.id : nextClientId('chat'),
    title,
    draft: typeof session.draft === 'string' ? session.draft : '',
    createdAt: typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
    messages,
    attachments,
  };
}

function buildSessionTitle(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized;
}

function getSessionPreview(session: AiChatSession) {
  const lastMessage = [...session.messages].reverse().find((message) => !message.isSystem);
  if (!lastMessage) {
    return '暂未开始对话';
  }

  return lastMessage.content.length > 28 ? `${lastMessage.content.slice(0, 28)}...` : lastMessage.content;
}

function isSessionStarted(session: AiChatSession) {
  return session.messages.some((message) => message.role === 'user');
}

function getPendingStatusLabel(action: AiPendingAction) {
  if (action.status === 'pending') {
    return '待确认';
  }

  if (action.status === 'confirmed') {
    return '已确认';
  }

  if (action.status === 'undone') {
    return '已撤回';
  }

  if (action.status === 'expired') {
    return '已过期';
  }

  return '已取消';
}

function getAttachmentTargetLabel(target: AiImportTarget) {
  if (target === 'customer') {
    return '客户';
  }

  if (target === 'product') {
    return '商品';
  }

  if (target === 'order') {
    return '订单';
  }

  return '自动识别';
}

function buildStorageKey(userId?: string) {
  return `retail-smart-hub.ai.sessions.${userId || 'anonymous'}`;
}

function restoreGlobalInputState() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }

  const selection = window.getSelection?.();
  if (selection && selection.type !== 'None') {
    selection.removeAllRanges();
  }

  document.body.style.removeProperty('pointer-events');
  document.body.style.removeProperty('user-select');
  document.documentElement.style.removeProperty('pointer-events');
  document.documentElement.style.removeProperty('user-select');

  window.requestAnimationFrame(() => {
    const root = document.getElementById('root');
    if (!root) {
      return;
    }

    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    if (typeof PointerEvent !== 'undefined') {
      root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    }
  });
}

type ActionMode = 'confirm' | 'cancel' | 'undo';

export function AIAssistant() {
  const { user } = useAuth();
  const { confirm: confirmDialogAction, confirmDialog } = useConfirmDialog();
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState('');
  const [isImportingFile, setIsImportingFile] = useState(false);
  const [error, setError] = useState('');
  const [showMorePrompts, setShowMorePrompts] = useState(false);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);

  const featuredQuickPrompts = useMemo(() => quickPrompts.slice(0, 6), []);
  const extendedQuickPrompts = useMemo(() => quickPrompts.slice(6), []);
  const storageKey = useMemo(() => buildStorageKey(user?.id), [user?.id]);

  const hydrateSessionsFromStorage = useCallback(() => {
    const snapshot = readStoredAiSessions(storageKey);
    if (!snapshot) {
      return false;
    }

    setSessions(snapshot.sessions);
    setActiveSessionId(snapshot.activeSessionId);
    return true;
  }, [storageKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    fetchAiStatus()
      .then((response) => {
        if (active) {
          setStatus(response.data);
        }
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : '模型状态读取失败');
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const runSessionStream = useCallback(
    async (input: {
      sessionId: string;
      assistantMessageId: string;
      payload: {
        prompt: string;
        history?: Array<{
          role: 'user' | 'assistant';
          content: string;
          toolCalls?: AiToolCall[];
          pendingActionId?: string;
          pendingActionName?: string;
          pendingActionStatus?: AiPendingAction['status'];
        }>;
        attachments?: AiAttachmentDraft[];
      };
    }) => {
      const taskKey = getStreamTaskKey(storageKey, input.sessionId);
      if (AI_STREAM_TASKS.has(taskKey)) {
        return;
      }

      AI_STREAM_TASKS.add(taskKey);
      emitAiSessionUpdate(storageKey);

      let latestMeta: AiChatStreamMeta | null = null;
      const startedAt = Date.now();
      const shouldUseStreaming = (status?.provider || '').trim().toLowerCase() === 'deepseek';

      const patchAssistantMessage = (
        updater: (message: AiMessage) => AiMessage,
        updatedAt?: string,
      ) => {
        mutateStoredAiSessions(storageKey, (snapshot) => ({
          ...snapshot,
          sessions: snapshot.sessions.map((session) => {
            if (session.id !== input.sessionId) {
              return session;
            }

            let changed = false;
            const nextMessages = session.messages.map((message) => {
              if (message.id !== input.assistantMessageId) {
                return message;
              }
              changed = true;
              return updater(message);
            });

            if (!changed) {
              return session;
            }

            return {
              ...session,
              updatedAt: updatedAt || new Date().toISOString(),
              messages: nextMessages,
            };
          }),
        }));
      };

      try {
        const response = shouldUseStreaming
          ? await streamAiChat(
              {
                prompt: input.payload.prompt,
                conversationId: input.sessionId,
                history: input.payload.history,
                attachments: input.payload.attachments ?? [],
              },
              {
                onMeta: (meta) => {
                  latestMeta = meta;
                  patchAssistantMessage((message) => ({
                    ...message,
                    meta: meta.note || `${meta.provider} / ${meta.model}`,
                    citations: meta.citations,
                    webSources: meta.webSources,
                    toolCalls: meta.toolCalls,
                    pendingAction: meta.pendingAction ? normalizePendingAction(meta.pendingAction) : undefined,
                    trace: meta.trace,
                  }));
                },
                onDelta: (delta) => {
                  patchAssistantMessage((message) => ({
                    ...message,
                    content: `${message.content}${delta.replyDelta || ''}`,
                    reasoningContent: `${message.reasoningContent || ''}${delta.reasoningDelta || ''}` || undefined,
                    reasoningDurationMs:
                      delta.reasoningDelta || message.reasoningContent
                        ? Date.now() - startedAt
                        : message.reasoningDurationMs,
                  }));
                },
              },
            )
          : (
              await sendAiChat({
                prompt: input.payload.prompt,
                conversationId: input.sessionId,
                history: input.payload.history,
                attachments: input.payload.attachments ?? [],
              })
            ).data;

        patchAssistantMessage(
          (message) => ({
            ...message,
            content: response.reply || message.content || '模型未返回可展示内容，请重试。',
            reasoningContent: response.reasoningContent || message.reasoningContent,
            reasoningDurationMs:
              response.reasoningContent || message.reasoningContent
                ? Date.now() - startedAt
                : message.reasoningDurationMs,
            meta: response.note || `${response.provider} / ${response.model}`,
            citations: response.citations,
            webSources: response.webSources,
            toolCalls: response.toolCalls,
            pendingAction: response.pendingAction ? normalizePendingAction(response.pendingAction) : undefined,
            trace: response.trace,
          }),
          new Date().toISOString(),
        );

        if (mountedRef.current) {
          setStatus((current) =>
            current
              ? {
                  ...current,
                  configured: response.configured,
                  provider: response.provider,
                  model: response.model,
                }
              : current,
          );
        }
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : '模型请求失败';
        patchAssistantMessage((draft) => ({
          ...draft,
          content: draft.content || `请求失败：${message}`,
          meta: '接口异常',
          citations: latestMeta?.citations || draft.citations,
          webSources: latestMeta?.webSources || draft.webSources,
          toolCalls: latestMeta?.toolCalls || draft.toolCalls,
          pendingAction: latestMeta?.pendingAction
            ? normalizePendingAction(latestMeta.pendingAction)
            : draft.pendingAction,
          trace: latestMeta?.trace || draft.trace,
        }));

        if (mountedRef.current) {
          setError(message);
        }
      } finally {
        AI_STREAM_TASKS.delete(taskKey);
        emitAiSessionUpdate(storageKey);
      }
    },
    [status?.provider, storageKey],
  );

  useEffect(() => {
    setSessionsReady(false);
    let snapshot = readStoredAiSessions(storageKey);

    if (snapshot) {
      const startedSessions = snapshot.sessions.filter((session) => isSessionStarted(session));
      if (startedSessions.length > 0) {
        const nextActiveSessionId = startedSessions.some((session) => session.id === snapshot.activeSessionId)
          ? snapshot.activeSessionId
          : startedSessions[0].id;
        snapshot = {
          activeSessionId: nextActiveSessionId,
          sessions: startedSessions,
        };
      } else {
        snapshot = null;
      }
    }

    if (!snapshot) {
      const freshSession = createSession();
      snapshot = {
        activeSessionId: freshSession.id,
        sessions: [freshSession],
      };
    }

    writeStoredAiSessions(storageKey, snapshot, false);
    setSessions(snapshot.sessions);
    setActiveSessionId(snapshot.activeSessionId);
    setSessionsReady(true);
  }, [storageKey]);

  useEffect(() => {
    const handleSessionUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey?: string }>).detail;
      if (!detail || detail.storageKey !== storageKey) {
        return;
      }

      hydrateSessionsFromStorage();
    };

    window.addEventListener(AI_SESSION_UPDATE_EVENT, handleSessionUpdate);
    return () => {
      window.removeEventListener(AI_SESSION_UPDATE_EVENT, handleSessionUpdate);
    };
  }, [hydrateSessionsFromStorage, storageKey]);

  useEffect(() => {
    if (!sessionsReady) {
      return;
    }

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        activeSessionId,
        sessions,
      }),
    );
  }, [activeSessionId, sessions, sessionsReady, storageKey]);

  useEffect(() => {
    if (!sessionsReady) {
      return;
    }

    const pendingActionIds = Array.from(
      new Set(
        sessions.flatMap((session) =>
          session.messages
            .map((message) => message.pendingAction)
            .filter((action): action is AiPendingAction => Boolean(action) && (action.status === 'pending' || action.status === 'expired'))
            .map((action) => action.id),
        ),
      ),
    );

    if (pendingActionIds.length === 0) {
      return;
    }

    let disposed = false;

    void Promise.all(
      pendingActionIds.map(async (actionId) => {
        try {
          const response = await fetchAiAction(actionId);
          return [actionId, normalizePendingAction(response.data)] as const;
        } catch {
          return [actionId, null] as const;
        }
      }),
    ).then((results) => {
      if (disposed) {
        return;
      }

      const actionMap = new Map(results);
      setSessions((current) => {
        let changed = false;

        const nextSessions = current.map((session) => ({
          ...session,
          messages: session.messages.map((message) => {
            if (!message.pendingAction) {
              return message;
            }

            const nextAction = actionMap.get(message.pendingAction.id) ?? normalizePendingAction(message.pendingAction);
            const currentSerialized = JSON.stringify(message.pendingAction);
            const nextSerialized = JSON.stringify(nextAction);
            if (currentSerialized !== nextSerialized) {
              changed = true;
              return {
                ...message,
                pendingAction: nextAction,
              };
            }

            return message;
          }),
        }));

        return changed ? nextSessions : current;
      });
    });

    return () => {
      disposed = true;
    };
  }, [sessions, sessionsReady]);

  const orderedSessions = useMemo(
    () => [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [sessions],
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions],
  );

  useEffect(() => {
    if (activeSession && activeSession.id !== activeSessionId) {
      setActiveSessionId(activeSession.id);
    }
  }, [activeSession, activeSessionId]);

  const statusText = useMemo(() => buildMeta(status), [status]);
  const input = activeSession?.draft ?? '';
  const messages = activeSession?.messages ?? [];
  const attachments = activeSession?.attachments ?? [];
  const isLoading = activeSession ? isAiSessionStreaming(storageKey, activeSession.id) : false;
  const messageCount = messages.length;

  const updateScrollToBottomVisibility = useCallback(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setShowScrollToBottom(distanceToBottom > 56);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    if (!sessionsReady) {
      return;
    }

    window.requestAnimationFrame(() => {
      scrollToBottom('auto');
    });
  }, [activeSessionId, sessionsReady, scrollToBottom]);

  useEffect(() => {
    if (!sessionsReady) {
      return;
    }

    window.requestAnimationFrame(() => {
      scrollToBottom('smooth');
    });
  }, [messageCount, sessionsReady, scrollToBottom]);

  function replaceSession(sessionId: string, updater: (session: AiChatSession) => AiChatSession) {
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? updater(session) : session)),
    );
  }

  function updateDraft(nextDraft: string) {
    if (!activeSession) {
      return;
    }

    replaceSession(activeSession.id, (session) => ({
      ...session,
      draft: nextDraft,
      updatedAt: new Date().toISOString(),
    }));
  }

  function handleCreateSession() {
    const nextSession = createSession(`新对话 ${sessions.length + 1}`);
    setSessions((current) => [nextSession, ...current]);
    setActiveSessionId(nextSession.id);
    setError('');
  }

  async function handleDeleteSession(sessionId: string) {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) {
      return;
    }

    const confirmed = await confirmDialogAction({
      title: '确认删除会话',
      message: `会话：${target.title}\n删除后该会话消息将从列表移除，且不可恢复。`,
      confirmText: '删除',
      confirmVariant: 'destructive',
    });
    if (!confirmed) {
      return;
    }

    const remaining = sessions.filter((session) => session.id !== target.id);
    if (remaining.length === 0) {
      const nextSession = createSession();
      setSessions([nextSession]);
      setActiveSessionId(nextSession.id);
      return;
    }

    setSessions(remaining);
    if (activeSessionId === target.id) {
      setActiveSessionId(remaining[0].id);
    }
  }

  async function handleSend(rawPrompt?: string) {
    if (!activeSession) {
      return;
    }

    const prompt = (rawPrompt ?? activeSession.draft).trim();
    const attachmentDrafts = activeSession.attachments ?? [];
    if (isLoading || isImportingFile || (!prompt && attachmentDrafts.length === 0)) {
      return;
    }

    const sessionId = activeSession.id;
    if (isAiSessionStreaming(storageKey, sessionId)) {
      return;
    }

    const history = activeSession.messages
      .filter((message) => !message.isSystem)
      .slice(-8)
      .map((message) => {
        const content = message.content.trim();
        const toolCalls = Array.isArray(message.toolCalls)
          ? message.toolCalls
              .map((item) => ({
                ...item,
                name: item.name.trim(),
                summary: item.summary.trim(),
              }))
              .filter((item) => item.name && item.summary)
          : undefined;

        return {
          role: message.role,
          content,
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          pendingActionId: message.pendingAction?.id,
          pendingActionName: message.pendingAction?.name,
          pendingActionStatus: message.pendingAction?.status,
        };
      })
      .filter((message) => message.content.length > 0);
    const hasRealMessages = activeSession.messages.some((message) => !message.isSystem && message.role === 'user');
    const userMessage: AiMessage = {
      id: nextClientId('user'),
      role: 'user',
      content:
        attachmentDrafts.length > 0
          ? `${prompt || '请处理我刚上传的附件'}\n\n附件：${attachmentDrafts
              .map((item) => `${item.fileName}（${getAttachmentTargetLabel(item.target)} / ${describeAttachment(item)}）`)
              .join('、')}`
          : prompt,
    };
    const assistantMessageId = nextClientId('assistant-stream');
    const assistantPlaceholder: AiMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      meta: '深度思考中',
    };

    const snapshot = mutateStoredAiSessions(storageKey, (current) => ({
      ...current,
      activeSessionId: sessionId,
      sessions: current.sessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        return {
          ...session,
          title: hasRealMessages
            ? session.title
            : buildSessionTitle(prompt || `附件 ${attachmentDrafts[0]?.fileName || '导入'}`),
          draft: '',
          attachments: [],
          updatedAt: new Date().toISOString(),
          messages: [...session.messages, userMessage, assistantPlaceholder],
        };
      }),
    }));

    if (snapshot) {
      setSessions(snapshot.sessions);
      setActiveSessionId(snapshot.activeSessionId);
    }

    setError('');

    void runSessionStream({
      sessionId,
      assistantMessageId,
      payload: {
        prompt,
        history,
        attachments: attachmentDrafts,
      },
    });
  }

  async function handleImportFile(file: File) {
    if (!activeSession || isImportingFile) {
      return;
    }

    const sessionId = activeSession.id;

    try {
      setError('');
      setIsImportingFile(true);
      const parsed = await parseAttachmentFile(file);

      const attachment: AiAttachmentDraft = {
        id: nextClientId('attachment'),
        fileName: parsed.fileName,
        target: 'auto',
        kind: parsed.kind,
        mimeType: parsed.mimeType,
        imageDataUrl: parsed.imageDataUrl,
        imageWidth: parsed.imageWidth,
        imageHeight: parsed.imageHeight,
        rowCount: parsed.rowCount,
        rows: parsed.rows,
        sheetCount: parsed.sheetCount,
        sheets: parsed.sheets,
        textContent: parsed.textContent,
        blocks: parsed.blocks,
        uploadedAt: new Date().toISOString(),
      };

      replaceSession(sessionId, (session) => ({
        ...session,
        updatedAt: new Date().toISOString(),
        attachments: [...(session.attachments ?? []), attachment],
      }));
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'AI 文件导入失败';
      setError(message);
    } finally {
      setIsImportingFile(false);
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
    }
  }

  function removeAttachment(attachmentId: string) {
    if (!activeSession) {
      return;
    }

    replaceSession(activeSession.id, (session) => ({
      ...session,
      updatedAt: new Date().toISOString(),
      attachments: (session.attachments ?? []).filter((item) => item.id !== attachmentId),
    }));
  }

  async function handlePendingAction(action: AiPendingAction, mode: ActionMode) {
    if (actionLoadingId) {
      return;
    }

    const ownerSession = sessions.find((session) =>
      session.messages.some((message) => message.pendingAction?.id === action.id),
    );

    if (!ownerSession) {
      setError('未找到对应的会话上下文，请刷新后重试。');
      return;
    }

    setActionLoadingId(action.id);
    setError('');
    restoreGlobalInputState();

    try {
      const response =
        mode === 'confirm'
          ? await confirmAiAction(action.id)
          : mode === 'cancel'
            ? await cancelAiAction(action.id)
            : await undoAiAction(action.id);

      setSessions((current) =>
        current.map((session) => {
          const hasTargetAction = session.messages.some((message) => message.pendingAction?.id === action.id);
          const updatedMessages = session.messages.map((message) => {
            if (message.pendingAction?.id !== action.id) {
              return message;
            }

            return {
              ...message,
              pendingAction: normalizePendingAction(response.data.pendingAction),
              toolCalls: mergeToolCalls(message.toolCalls, response.data.toolCall),
            };
          });

          if (!hasTargetAction) {
            return session;
          }

          const followUpMessage: AiMessage = {
            id: nextClientId(`assistant-action-${mode}`),
            role: 'assistant',
            content: response.data.reply,
            meta:
              mode === 'confirm'
                ? '已确认执行'
                : mode === 'undo'
                  ? '已撤回执行'
                  : '已取消执行',
            toolCalls: [response.data.toolCall],
            pendingAction: normalizePendingAction(response.data.pendingAction),
            trace: response.data.trace,
          };

          return {
            ...session,
            updatedAt: new Date().toISOString(),
            messages: [...updatedMessages, followUpMessage],
          };
        }),
      );

      setActiveSessionId(ownerSession.id);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : '待确认操作处理失败';
      setError(message);

      try {
        const latest = await fetchAiAction(action.id);
        setSessions((current) =>
          current.map((session) => ({
            ...session,
            messages: session.messages.map((messageItem) => {
              if (messageItem.pendingAction?.id !== action.id) {
                return messageItem;
              }

              return {
                ...messageItem,
                pendingAction: normalizePendingAction(latest.data),
              };
            }),
          })),
        );
      } catch {
        setSessions((current) =>
          current.map((session) => ({
            ...session,
            messages: session.messages.map((messageItem) => {
              if (messageItem.pendingAction?.id !== action.id) {
                return messageItem;
              }

              return {
                ...messageItem,
                pendingAction: normalizePendingAction(messageItem.pendingAction),
              };
            }),
          })),
        );
      }
    } finally {
      setActionLoadingId('');
      window.setTimeout(() => {
        restoreGlobalInputState();
      }, 0);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_380px]">

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="border-b border-slate-100 bg-slate-50/70">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-slate-900">
                <Bot className="h-5 w-5 text-blue-600" />
                AI 智能助手
              </CardTitle>
              <CardDescription>支持多会话、附件处理与受控执行确认。</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={status?.configured ? 'success' : 'warning'}>{statusText}</Badge>
              <Badge variant="outline">会话 {sessions.length}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 p-5">
          <div className="relative">
            <div
              ref={messageViewportRef}
              onScroll={updateScrollToBottomVisibility}
              className="max-h-[62vh] min-h-[56vh] space-y-5 overflow-y-auto rounded-2xl bg-slate-50 p-6 pb-12"
            >
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`flex max-w-[92%] items-start gap-2 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  {message.role === 'assistant' ? (
                    <span className="mt-1 inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border border-blue-200 bg-white text-blue-600 shadow-sm">
                      <Bot className="h-4.5 w-4.5" />
                    </span>
                  ) : null}
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                    message.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'border border-slate-200 bg-white text-slate-800'
                  }`}
                >
                  {message.role === 'assistant' && message.reasoningContent ? (
                    <details open className="group mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-slate-700">
                        <span>已深度思考{formatReasoningSeconds(message.reasoningDurationMs)}秒</span>
                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                      </summary>
                      <div className="mt-2 whitespace-pre-wrap leading-5">{message.reasoningContent}</div>
                    </details>
                  ) : null}
                  <div className="whitespace-pre-wrap leading-6">{message.content}</div>
                  {message.meta ? (
                    <div
                      className={`mt-2 text-xs ${
                        message.role === 'user' ? 'text-blue-100' : 'text-slate-500'
                      }`}
                    >
                      {message.meta}
                    </div>
                  ) : null}
                  {message.role === 'assistant' && message.trace && message.trace.length > 0 ? (
                    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <summary className="cursor-pointer list-none font-medium text-slate-700">
                        处理轨迹
                      </summary>
                      <div className="mt-2 space-y-1">
                        {message.trace.map((item) => (
                          <div key={`${message.id}-${item}`}>- {item}</div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {message.role === 'assistant' && message.citations && message.citations.length > 0 ? (
                    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <div className="font-medium text-slate-700">引用来源</div>
                      <div className="mt-1 space-y-1">
                        {message.citations.map((citation) => (
                          <div key={`${message.id}-${citation}`}>{citation}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {message.role === 'assistant' && message.webSources && message.webSources.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs text-slate-700">
                      <div className="font-medium text-slate-800">联网来源</div>
                      <div className="mt-2 space-y-2">
                        {message.webSources.map((source, index) => {
                          const published = formatSourcePublishedDate(source.publishedDate);
                          const cardBody = (
                            <>
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-slate-900">
                                    {source.title || `来源 ${index + 1}`}
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-sky-700">
                                    <span>{formatSourceDomain(source.url)}</span>
                                    {published ? <span>{published}</span> : null}
                                    {typeof source.score === 'number' ? (
                                      <span>score {source.score.toFixed(2)}</span>
                                    ) : null}
                                  </div>
                                </div>
                                {source.url ? <ExternalLink className="mt-0.5 h-3.5 w-3.5 flex-none text-sky-700" /> : null}
                              </div>
                              {source.snippet ? (
                                <div className="mt-1 line-clamp-3 text-[11px] leading-5 text-slate-600">{source.snippet}</div>
                              ) : null}
                            </>
                          );

                          if (!source.url) {
                            return (
                              <div
                                key={`${message.id}-source-${index}`}
                                className="block rounded-lg border border-sky-100 bg-white px-3 py-2"
                              >
                                {cardBody}
                              </div>
                            );
                          }

                          return (
                            <a
                              key={`${message.id}-source-${index}`}
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block rounded-lg border border-sky-100 bg-white px-3 py-2 transition hover:border-sky-300 hover:bg-sky-50"
                            >
                              {cardBody}
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <div className="font-medium text-slate-700">工具调用</div>
                      <div className="mt-1 space-y-1">
                        {message.toolCalls.map((toolCall) => (
                          <div key={`${message.id}-${toolCall.name}`} className="flex items-start justify-between gap-3">
                            <span className="font-medium text-slate-700">{toolCall.name}</span>
                            <span className="text-right">{toolCall.summary}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {message.role === 'assistant' && message.pendingAction ? (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium">受控操作</div>
                        <Badge
                          variant={
                            message.pendingAction.status === 'pending'
                              ? 'warning'
                              : message.pendingAction.status === 'undone'
                                ? 'outline'
                                : message.pendingAction.status === 'expired'
                                  ? 'outline'
                                : 'secondary'
                          }
                        >
                          {getPendingStatusLabel(message.pendingAction)}
                        </Badge>
                      </div>
                      <div className="mt-2 space-y-1">
                        <div>{message.pendingAction.summary}</div>
                        <div>{message.pendingAction.confirmationMessage}</div>
                        <div>过期时间：{formatDateTime(message.pendingAction.expiresAt)}</div>
                        {message.pendingAction.undoneAt ? (
                          <div>撤回时间：{formatDateTime(message.pendingAction.undoneAt)}</div>
                        ) : null}
                        {message.pendingAction.status === 'expired' ? (
                          <div>该待确认动作已超过有效期，如需继续请重新发起。</div>
                        ) : null}
                      </div>
                      {message.pendingAction.status === 'pending' ? (
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => void handlePendingAction(message.pendingAction as AiPendingAction, 'confirm')}
                            disabled={Boolean(actionLoadingId)}
                          >
                            {actionLoadingId === message.pendingAction.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            确认执行
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handlePendingAction(message.pendingAction as AiPendingAction, 'cancel')}
                            disabled={Boolean(actionLoadingId)}
                          >
                            取消
                          </Button>
                        </div>
                      ) : null}
                      {message.pendingAction.status === 'confirmed' && message.pendingAction.canUndo ? (
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handlePendingAction(message.pendingAction as AiPendingAction, 'undo')}
                            disabled={Boolean(actionLoadingId)}
                          >
                            {actionLoadingId === message.pendingAction.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                            撤回执行
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                </div>
              </div>
            ))}
            {isLoading ? (
              <div className="flex justify-start pl-10">
                <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  深度思考中
                </div>
              </div>
            ) : null}
              {isImportingFile ? (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在解析附件
                  </div>
                </div>
              ) : null}
            </div>
            {showScrollToBottom ? (
              <button
                type="button"
                className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-blue-200 hover:text-blue-600"
                onClick={() => {
                  scrollToBottom('smooth');
                }}
                title="回到底部"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {featuredQuickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 transition hover:bg-blue-100"
                  onClick={() => {
                    updateDraft(prompt);
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
            {showMorePrompts ? (
              <div className="flex flex-wrap gap-2">
                {extendedQuickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 transition hover:bg-blue-100"
                    onClick={() => {
                      updateDraft(prompt);
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
            {extendedQuickPrompts.length > 0 ? (
              <button
                type="button"
                className="text-xs font-medium text-slate-500 transition hover:text-slate-700"
                onClick={() => {
                  setShowMorePrompts((current) => !current);
                }}
              >
                {showMorePrompts ? '收起更多示例' : '展开更多示例'}
              </button>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}

          <div className="space-y-2">
            <div className="flex gap-3">
              <input
                ref={importInputRef}
                type="file"
                accept=".md,.txt,.csv,.xls,.xlsx,.pdf,.docx,.html,.htm,.png,.jpg,.jpeg,.webp,.gif"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleImportFile(file);
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="上传文件"
                onClick={() => {
                  importInputRef.current?.click();
                }}
                disabled={isLoading || isImportingFile}
              >
                {isImportingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              </Button>
              <Input
                value={input}
                disabled={isLoading || isImportingFile}
                onChange={(event) => {
                  updateDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void handleSend();
                  }
                }}
                placeholder="输入你的问题，例如：帮我看一下财务概览或帮我生成低库存补货采购单"
                className="bg-white"
              />
              <Button onClick={() => void handleSend()} disabled={isLoading || isImportingFile || (!input.trim() && attachments.length === 0)}>
                {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                发送
              </Button>
            </div>
            {attachments.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700"
                  >
                    <span className="max-w-[220px] truncate">{attachment.fileName}</span>
                    <button
                      type="button"
                      className="text-slate-400 transition hover:text-slate-700"
                      onClick={() => {
                        removeAttachment(attachment.id);
                      }}
                      disabled={isLoading || isImportingFile}
                      title="移除附件"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                  <Workflow className="h-4 w-4 text-slate-700" />
                  对话记录
                </CardTitle>
                <CardDescription>支持自动保存、切换和删除。</CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={handleCreateSession}>
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                新建
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {orderedSessions.map((session) => {
              const isActive = session.id === activeSession?.id;
              return (
                <div
                  key={session.id}
                  className={`rounded-xl border px-3 py-3 transition ${
                    isActive ? 'border-blue-300 bg-blue-50/70' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        setActiveSessionId(session.id);
                        setError('');
                      }}
                    >
                      <div className="truncate text-sm font-medium text-slate-900">{session.title}</div>
                      <div className="mt-1 line-clamp-2 text-xs text-slate-500">{getSessionPreview(session)}</div>
                      <div className="mt-2 text-[11px] text-slate-400">{formatDateTime(session.updatedAt)}</div>
                    </button>
                    <button
                      type="button"
                      className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                      onClick={() => {
                        void handleDeleteSession(session.id);
                      }}
                      title="删除会话"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-900">
              <Sparkles className="h-4 w-4 text-amber-500" />
              当前能力
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <div className="flex items-center justify-between">
              <span>模型对话</span>
              <Badge variant={status?.configured ? 'success' : 'warning'}>
                {status?.configured ? '已接通' : '待配置'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>RAG 检索</span>
              <Badge variant={status?.ragEnabled ? 'success' : 'outline'}>{status?.ragEnabled ? '已启用' : '未启用'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Function Use</span>
              <Badge variant={status?.functionUseEnabled ? 'success' : 'outline'}>
                {status?.functionUseEnabled ? '已启用（含确认链路）' : '未启用'}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card className="border-amber-200 bg-amber-50/70 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-amber-900">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              当前边界
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-amber-900/80">
            <p>1. 支持保存会话、切换、删除和继续补参数，但还未做跨账号共享。</p>
            <p>2. 撤回目前只覆盖客户创建、收款、付款和新建订单 4 类动作。</p>
            <p>3. 展示的是安全处理轨迹，不展示模型原始推理内容。</p>
          </CardContent>
        </Card>
      </div>
      {confirmDialog}
    </div>
  );
}

