import { env, getActiveAiModel, isAiConfigured } from '../../config/env';
import { planRuntimeWriteAction } from './action.service';
import type { AiApproval, AiPendingAction, AiToolCallRecord } from './dto/tool.dto';

export type AiImportTarget = 'auto' | 'customer' | 'product' | 'order';
export type ResolvedAiImportTarget = Exclude<AiImportTarget, 'auto'>;
export type AiAttachmentKind = 'document' | 'table' | 'workbook' | 'image';
type DocumentMode = 'analyze' | 'preview' | 'validate' | 'import';

export interface AiDocumentLocator {
  [key: string]: unknown;
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

export interface AiDocumentBlock {
  blockId: string;
  type: 'paragraph' | 'heading' | 'page' | 'sheet_summary' | 'table_summary';
  text: string;
  title?: string;
  locator: AiDocumentLocator;
}

export interface AiDocumentSheet {
  name: string;
  rowCount?: number;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

export interface AiDocumentAttachment {
  id?: string;
  fileName: string;
  target: AiImportTarget;
  kind?: AiAttachmentKind;
  mimeType?: string;
  imageDataUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  rowCount?: number;
  rows: Array<Record<string, unknown>>;
  sheetCount?: number;
  sheets?: AiDocumentSheet[];
  textContent?: string;
  blocks?: AiDocumentBlock[];
}

export interface AiDocumentSkillRequest {
  prompt: string;
  attachments: AiDocumentAttachment[];
  userId: string;
  username: string;
  permissions: string[];
}

export interface AiDocumentSkillResponse {
  handled: boolean;
  reply: string;
  note: string;
  toolCalls: AiToolCallRecord[];
  citations: string[];
  trace: string[];
  pendingAction?: AiPendingAction;
  approval?: AiApproval;
  configured: boolean;
  provider: string;
  model: string;
}

interface ImportTargetProfile {
  target: ResolvedAiImportTarget;
  label: string;
  permission: string;
  aliases: string[];
  toolName: string;
}

interface ResolvedAttachment {
  fileName: string;
  sheetName?: string;
  target: ResolvedAiImportTarget;
  profile: ImportTargetProfile;
  rows: Array<Record<string, unknown>>;
}

interface DocumentImportPendingPayload {
  requiredPermissions: string[];
  operations: Array<{
    target: ResolvedAiImportTarget;
    fileName: string;
    rows: Array<Record<string, unknown>>;
  }>;
}

const TARGET_PROFILES: ImportTargetProfile[] = [
  {
    target: 'customer',
    label: '客户',
    permission: 'settings.master-data',
    aliases: ['customername', 'customer', 'name', '客户', '客户名称', 'channel', 'contact', 'contactname', 'phone', 'mobile'],
    toolName: 'import_customer_master_data',
  },
  {
    target: 'product',
    label: '商品',
    permission: 'settings.master-data',
    aliases: ['sku', 'productcode', 'productname', 'name', '商品', '商品名称', 'category', 'unit', 'safestock', 'saleprice', 'costprice', 'supplier'],
    toolName: 'import_product_master_data',
  },
  {
    target: 'order',
    label: '订单',
    permission: 'orders.create',
    aliases: ['orderno', 'ordercode', '订单', '订单编号', 'customername', 'customer', 'deliverydate', 'sku', 'productname', 'quantity', 'qty', 'unitprice', 'price', 'remark'],
    toolName: 'import_sales_orders',
  },
];

const VALIDATE_SIGNALS = ['校验', '检查', '查错', 'validate', 'check'];
const PREVIEW_SIGNALS = ['预览', '看一下', '看看', '概览', 'summary', 'preview'];
const IMPORT_SIGNALS = ['导入', '写入', '录入', '新建', '创建', '新增', '入库', 'import', 'create', 'add'];

const EMPTY_DOCUMENT_SKILL_RESPONSE: AiDocumentSkillResponse = {
  handled: false,
  reply: '',
  note: '',
  toolCalls: [],
  citations: [],
  trace: [],
  pendingAction: undefined,
  approval: undefined,
  configured: isAiConfigured(),
  provider: env.aiProvider,
  model: getActiveAiModel(),
};

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[\s_\-()\[\]{}:]/g, '').trim();
}

function normalizePrompt(value: string) {
  return value.trim().toLowerCase();
}

function compactText(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeRecordList(rows: Array<Record<string, unknown>>) {
  return rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function safeBlockList(blocks: AiDocumentAttachment['blocks']) {
  return (blocks ?? []).filter(
    (block): block is AiDocumentBlock =>
      Boolean(block) &&
      typeof block === 'object' &&
      typeof block.blockId === 'string' &&
      typeof block.text === 'string' &&
      Boolean(block.text.trim()),
  );
}

function safeSheetList(sheets: AiDocumentAttachment['sheets']) {
  return (sheets ?? [])
    .map((sheet) => ({
      name: String(sheet?.name ?? '').trim(),
      rowCount: Number.isFinite(sheet?.rowCount) ? Number(sheet?.rowCount) : safeRecordList(sheet?.rows ?? []).length,
      headers: Array.isArray(sheet?.headers) ? sheet.headers.map((item) => String(item).trim()).filter(Boolean) : [],
      rows: safeRecordList(sheet?.rows ?? []),
    }))
    .filter((sheet) => sheet.name);
}

function flattenSheetRows(sheets: ReturnType<typeof safeSheetList>) {
  return sheets.flatMap((sheet) =>
    sheet.rows.map((row) => ({
      ...row,
      sheetName: typeof row.sheetName === 'string' && row.sheetName ? row.sheetName : sheet.name,
    })),
  );
}

function getEffectiveRows(attachment: AiDocumentAttachment) {
  const rows = safeRecordList(attachment.rows ?? []);
  if (rows.length > 0) {
    return rows;
  }
  return flattenSheetRows(safeSheetList(attachment.sheets));
}

function hasDocumentPayload(attachment: AiDocumentAttachment) {
  return (
    safeBlockList(attachment.blocks).length > 0 ||
    compactText(attachment.textContent).length > 0 ||
    compactText(attachment.imageDataUrl).length > 0
  );
}

function summarizeHeaders(rows: Array<Record<string, unknown>>) {
  return Array.from(new Set(rows.slice(0, 5).flatMap((row) => Object.keys(row)).filter(Boolean))).slice(0, 12);
}

function inferImportTarget(rows: Array<Record<string, unknown>>) {
  const headers = Array.from(
    new Set(
      rows
        .slice(0, 5)
        .flatMap((row) => Object.keys(row))
        .map((key) => normalizeKey(key))
        .filter(Boolean),
    ),
  );

  if (headers.length === 0) {
    return null;
  }

  const scoredProfiles = TARGET_PROFILES.map((profile) => {
    const aliasSet = new Set(profile.aliases.map((item) => normalizeKey(item)));
    const score = headers.reduce((sum, header) => sum + (aliasSet.has(header) ? 1 : 0), 0);
    return { profile, score };
  }).sort((left, right) => right.score - left.score);

  if (!scoredProfiles[0] || scoredProfiles[0].score === 0) {
    return null;
  }

  if (scoredProfiles[1] && scoredProfiles[0].score === scoredProfiles[1].score) {
    return null;
  }

  return scoredProfiles[0].profile;
}

function resolveTargetProfile(target: AiImportTarget, rows: Array<Record<string, unknown>>) {
  if (target !== 'auto') {
    return TARGET_PROFILES.find((profile) => profile.target === target) ?? null;
  }

  return inferImportTarget(rows);
}

function ensureImportPermission(profile: ImportTargetProfile, permissions: string[]) {
  if (!permissions.includes(profile.permission)) {
    throw new Error(`Missing permission for ${profile.label} import: ${profile.permission}`);
  }
}

function detectDocumentMode(prompt: string): DocumentMode {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return 'preview';
  }

  if (VALIDATE_SIGNALS.some((signal) => normalized.includes(signal))) {
    return 'validate';
  }

  if (PREVIEW_SIGNALS.some((signal) => normalized.includes(signal))) {
    return 'preview';
  }

  if (IMPORT_SIGNALS.some((signal) => normalized.includes(signal))) {
    return 'import';
  }

  return 'analyze';
}

function detectRequestedTargets(prompt: string): ResolvedAiImportTarget[] {
  const normalized = normalizePrompt(prompt);
  const targets: ResolvedAiImportTarget[] = [];

  if (normalized.includes('客户') || normalized.includes('customer')) {
    targets.push('customer');
  }

  if (normalized.includes('商品') || normalized.includes('sku') || normalized.includes('product')) {
    targets.push('product');
  }

  if (normalized.includes('订单') || normalized.includes('order')) {
    targets.push('order');
  }

  return Array.from(new Set(targets));
}

function resolveAttachments(attachments: AiDocumentAttachment[]) {
  const resolved: ResolvedAttachment[] = [];
  const unresolved: string[] = [];

  for (const attachment of attachments) {
    const sheets = safeSheetList(attachment.sheets);
    const units =
      sheets.length > 0
        ? sheets.map((sheet) => ({
            label: `${attachment.fileName}#${sheet.name}`,
            fileName: attachment.fileName,
            sheetName: sheet.name,
            rows: sheet.rows,
          }))
        : [
            {
              label: attachment.fileName,
              fileName: attachment.fileName,
              sheetName: undefined,
              rows: getEffectiveRows(attachment),
            },
          ];

    const hasTabularPayload = units.some((unit) => unit.rows.length > 0);
    if (!hasTabularPayload) {
      if (!hasDocumentPayload(attachment)) {
        unresolved.push(attachment.fileName);
      }
      continue;
    }

    for (const unit of units) {
      if (unit.rows.length === 0) {
        continue;
      }

      const profile = resolveTargetProfile(attachment.target, unit.rows);
      if (!profile) {
        unresolved.push(unit.label);
        continue;
      }

      resolved.push({
        fileName: unit.fileName,
        sheetName: unit.sheetName,
        target: profile.target,
        profile,
        rows: unit.rows,
      });
    }
  }

  return { resolved, unresolved };
}

function formatAttachmentLine(item: ResolvedAttachment, index: number) {
  const headers = summarizeHeaders(item.rows);
  const scopedName = item.sheetName ? `${item.fileName}#${item.sheetName}` : item.fileName;
  return `${index + 1}. ${scopedName} -> ${item.profile.label} (${item.rows.length} rows, fields: ${headers.join(', ') || '-'})`;
}

function summarizeSampleRow(rows: Array<Record<string, unknown>>) {
  const firstRow = rows[0];
  if (!firstRow) {
    return '';
  }

  const entries = Object.entries(firstRow)
    .filter(([key]) => Boolean(key))
    .slice(0, 6)
    .map(([key, value]) => {
      const text = value == null ? '' : compactText(value);
      return `${key}=${text.length > 32 ? `${text.slice(0, 32)}...` : text}`;
    });

  return entries.join('; ');
}

function summarizeDocumentAttachment(attachment: AiDocumentAttachment) {
  if ((attachment.kind || '').trim() === 'image' || compactText(attachment.imageDataUrl).length > 0) {
    const dimensions =
      typeof attachment.imageWidth === 'number' && typeof attachment.imageHeight === 'number'
        ? `${attachment.imageWidth}x${attachment.imageHeight}`
        : 'unknown size';
    return {
      pageCount: 0,
      blockCount: 0,
      excerpts: [`${attachment.fileName}: image attachment (${attachment.mimeType || 'image'}, ${dimensions})`],
    };
  }

  const blocks = safeBlockList(attachment.blocks);
  const pageCount = blocks.filter((block) => block.type === 'page').length;
  const excerpts =
    blocks.length > 0
      ? blocks.slice(0, 3).map((block) => {
          const locator: string[] = [];
          if (typeof block.locator?.page === 'number') {
            locator.push(`page ${block.locator.page}`);
          }
          if (typeof block.locator?.paragraph === 'number') {
            locator.push(`paragraph ${block.locator.paragraph}`);
          }
          if (typeof block.locator?.sheetName === 'string' && block.locator.sheetName.trim()) {
            locator.push(`sheet ${block.locator.sheetName.trim()}`);
          }
          const location = locator.length > 0 ? ` [${locator.join(', ')}]` : '';
          return `${block.title || attachment.fileName}${location}: ${compactText(block.text).slice(0, 220)}`;
        })
      : compactText(attachment.textContent)
          .split(/\n{2,}/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 2)
          .map((item) => `${attachment.fileName}: ${item.slice(0, 220)}`);

  return {
    pageCount,
    blockCount: blocks.length,
    excerpts,
  };
}

function pickPrimaryRequiredPermission(requiredPermissions: string[]) {
  if (requiredPermissions.includes('orders.create')) {
    return 'orders.create';
  }
  if (requiredPermissions.includes('settings.master-data')) {
    return 'settings.master-data';
  }
  return requiredPermissions[0] || 'orders.create';
}

export function buildAttachmentContext(attachments: AiDocumentAttachment[]) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return '';
  }

  const { resolved, unresolved } = resolveAttachments(attachments);
  const lines: string[] = [];
  lines.push(`Uploaded attachments: ${attachments.length}`);
  lines.push('Attachments remain evidence/context unless the user explicitly requests import.');

  resolved.forEach((item, index) => {
    lines.push(formatAttachmentLine(item, index));
    const sample = summarizeSampleRow(item.rows);
    if (sample) {
      lines.push(`Sample row: ${sample}`);
    }
  });

  attachments.forEach((attachment, index) => {
    const summary = summarizeDocumentAttachment(attachment);
    if (summary.excerpts.length === 0) {
      return;
    }
    const blockLabel =
      summary.pageCount > 0
        ? `${summary.pageCount} page(s)`
        : summary.blockCount > 0
          ? `${summary.blockCount} block(s)`
          : 'document';
    lines.push(`${resolved.length + index + 1}. ${attachment.fileName} -> ${blockLabel}`);
    summary.excerpts.forEach((excerpt) => {
      lines.push(`Excerpt: ${excerpt}`);
    });
  });

  if (unresolved.length > 0) {
    lines.push(`Unresolved import/table typing: ${unresolved.join(', ')}`);
  }

  return lines.join('\n');
}

function buildPreviewReply(
  attachments: AiDocumentAttachment[],
  resolved: ResolvedAttachment[],
  unresolved: string[],
  mode: Exclude<DocumentMode, 'import' | 'analyze'>,
) {
  const lines: string[] = [];
  lines.push(mode === 'validate' ? 'Attachment structure validation completed. No write was executed.' : 'Attachment preview completed. No write was executed.');

  if (resolved.length > 0 || attachments.some((item) => hasDocumentPayload(item))) {
    lines.push(buildAttachmentContext(attachments));
  }

  if (unresolved.length > 0) {
    lines.push(`These files could not be typed for import: ${unresolved.join(', ')}`);
  }

  lines.push('To execute a write, send an explicit command such as "execute import" or "import these files".');
  return lines.join('\n');
}

export function processDocumentSkill(input: AiDocumentSkillRequest): AiDocumentSkillResponse {
  if (!Array.isArray(input.attachments) || input.attachments.length === 0) {
    return EMPTY_DOCUMENT_SKILL_RESPONSE;
  }

  const mode = detectDocumentMode(input.prompt);
  if (mode === 'analyze') {
    return EMPTY_DOCUMENT_SKILL_RESPONSE;
  }

  const requestedTargets = detectRequestedTargets(input.prompt);
  const { resolved, unresolved } = resolveAttachments(input.attachments);
  const scopedResolved =
    requestedTargets.length > 0 ? resolved.filter((item) => requestedTargets.includes(item.target)) : resolved;
  const citations = ['docs/rag/knowledge/批量导入与AI直录入说明.md'];
  const baseTrace = [
    `document skill: attachments=${input.attachments.length}`,
    `document mode: ${mode}`,
    `recognized=${resolved.length}, unresolved=${unresolved.length}`,
  ];

  if (mode === 'preview' || mode === 'validate') {
    const previewContext = buildAttachmentContext(input.attachments);
    if (!previewContext) {
      return {
        handled: true,
        reply: 'No previewable attachment content found.',
        note: 'Document skill preview mode, no write executed.',
        toolCalls: [
          {
            name: 'document_skill_preview',
            status: 'disabled',
            summary: 'No attachment content can be previewed.',
          },
        ],
        citations,
        trace: [...baseTrace, 'preview skipped: no attachment payload'],
        configured: isAiConfigured(),
        provider: env.aiProvider,
        model: getActiveAiModel(),
      };
    }

    return {
      handled: true,
      reply: buildPreviewReply(input.attachments, scopedResolved, unresolved, mode),
      note: 'Document skill preview mode, no write executed.',
      toolCalls: [
        {
          name: 'document_skill_preview',
          status: 'completed',
          summary: `previewed ${input.attachments.length} attachment(s), unresolved ${unresolved.length}.`,
        },
      ],
      citations,
      trace: [...baseTrace, 'preview completed; waiting for explicit import confirmation intent'],
      configured: isAiConfigured(),
      provider: env.aiProvider,
      model: getActiveAiModel(),
    };
  }

  if (scopedResolved.length === 0) {
    return {
      handled: true,
      reply:
        unresolved.length > 0
          ? `Import intent detected, but unresolved attachment types remain: ${unresolved.join(', ')}`
          : 'Import intent detected, but no executable tabular attachment matched the current scope.',
      note: 'Document skill import mode, no write executed.',
      toolCalls: [
        {
          name: 'document_skill_router',
          status: 'disabled',
          summary: 'No executable attachment found.',
        },
      ],
      citations,
      trace: [...baseTrace, 'import planning skipped: no executable attachment'],
      configured: isAiConfigured(),
      provider: env.aiProvider,
      model: getActiveAiModel(),
    };
  }

  const toolCalls: AiToolCallRecord[] = [];
  const traces = [...baseTrace];
  const executable: ResolvedAttachment[] = [];

  for (const attachment of scopedResolved) {
    try {
      ensureImportPermission(attachment.profile, input.permissions);
      executable.push(attachment);
      toolCalls.push({
        name: attachment.profile.toolName,
        status: 'planned',
        summary: `${attachment.fileName}${attachment.sheetName ? `#${attachment.sheetName}` : ''} -> parsed and waiting for approval`,
      });
      traces.push(`candidate accepted: ${attachment.fileName}${attachment.sheetName ? `#${attachment.sheetName}` : ''} -> ${attachment.target}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      toolCalls.push({
        name: attachment.profile.toolName,
        status: 'disabled',
        summary: `${attachment.fileName}${attachment.sheetName ? `#${attachment.sheetName}` : ''} -> ${message}`,
      });
      traces.push(`candidate rejected: ${attachment.fileName}${attachment.sheetName ? `#${attachment.sheetName}` : ''} -> ${message}`);
    }
  }

  if (unresolved.length > 0) {
    toolCalls.push({
      name: 'document_skill_router',
      status: 'disabled',
      summary: `${unresolved.length} attachment(s) unresolved and excluded from import`,
    });
    traces.push(`unresolved attachments: ${unresolved.join(', ')}`);
  }

  if (executable.length === 0) {
    return {
      handled: true,
      reply: 'Import intent detected, but no approved candidate remains (permission/type mismatch).',
      note: 'Document skill import mode, no pending action created.',
      toolCalls,
      citations,
      trace: [...traces, 'result: no write action planned'],
      configured: isAiConfigured(),
      provider: env.aiProvider,
      model: getActiveAiModel(),
    };
  }

  const requiredPermissions = Array.from(new Set(executable.map((item) => item.profile.permission)));
  const pendingPayload: DocumentImportPendingPayload = {
    requiredPermissions,
    operations: executable.map((item) => ({
      target: item.target,
      fileName: item.sheetName ? `${item.fileName}#${item.sheetName}` : item.fileName,
      rows: item.rows,
    })),
  };

  const planned = planRuntimeWriteAction({
    toolName: 'import_documents_batch',
    actionName: 'import_documents_batch',
    requiredPermission: pickPrimaryRequiredPermission(requiredPermissions),
    payload: pendingPayload as unknown as Record<string, unknown>,
    summary: `Pending confirmation: import attachment data (${executable.length} unit(s))`,
    confirmationMessage: 'The recognized attachment data will be imported after confirmation. No write will happen before you confirm.',
    userId: input.userId,
    username: input.username,
  });
  const { pendingAction, approval, toolCall } = planned;

  toolCalls.push({
    ...toolCall,
    summary: `pending action created: ${pendingAction.id}`,
  });

  return {
    handled: true,
    reply: [
      `Detected ${executable.length} import-ready attachment unit(s).`,
      'Pending action created. Confirm first to execute write operations.',
      `Approval ID: ${pendingAction.id}`,
    ].join('\n'),
    note: 'Document skill import mode now uses controlled-write approval flow.',
    toolCalls,
    citations,
    trace: [...traces, 'result: pending action created, no direct write executed'],
    pendingAction,
    approval,
    configured: isAiConfigured(),
    provider: env.aiProvider,
    model: getActiveAiModel(),
  };
}
