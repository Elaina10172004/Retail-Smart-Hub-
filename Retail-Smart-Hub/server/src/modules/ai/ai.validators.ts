import { z } from 'zod';
import { parseWithSchema } from '../../shared/validation';

const toolCallStatusSchema = z.enum(['planned', 'disabled', 'completed', 'awaiting_confirmation', 'cancelled', 'reverted']);
const pendingActionStatusSchema = z.enum(['pending', 'confirmed', 'cancelled', 'undone', 'expired']);
const attachmentKindSchema = z.enum(['document', 'table', 'workbook', 'image']);
const attachmentLocatorSchema = z
  .object({
    attachmentId: z.string().trim().optional(),
    fileName: z.string().trim().optional(),
    kind: attachmentKindSchema.optional(),
    page: z.number().int().min(1).optional(),
    paragraph: z.number().int().min(1).optional(),
    sectionTitle: z.string().trim().optional(),
    headingPath: z.array(z.string().trim().min(1)).optional(),
    blockId: z.string().trim().optional(),
    sheetName: z.string().trim().optional(),
    rowStart: z.number().int().min(1).optional(),
    rowEnd: z.number().int().min(1).optional(),
    columnStart: z.number().int().min(1).optional(),
    columnEnd: z.number().int().min(1).optional(),
    cellRange: z.string().trim().optional(),
    charStart: z.number().int().min(0).optional(),
    charEnd: z.number().int().min(0).optional(),
  })
  .passthrough();

const attachmentBlockSchema = z.object({
  blockId: z.string().trim().min(1),
  type: z.enum(['paragraph', 'heading', 'page', 'sheet_summary', 'table_summary']).optional().default('paragraph'),
  text: z.string().trim().min(1).max(50_000),
  title: z.string().trim().max(500).optional(),
  locator: attachmentLocatorSchema.optional().default({}),
});

const attachmentSheetSchema = z.object({
  name: z.string().trim().min(1),
  rowCount: z.number().int().min(0).optional(),
  headers: z.array(z.string().trim().min(1)).optional().default([]),
  rows: z.array(z.record(z.string(), z.unknown())).optional().default([]),
});

const attachmentSchema = z.object({
  id: z.string().optional(),
  fileName: z.string().trim().min(1),
  target: z.enum(['auto', 'customer', 'product', 'order']).optional(),
  kind: attachmentKindSchema.optional(),
  mimeType: z.string().trim().max(200).optional(),
  imageDataUrl: z.string().max(8_000_000).optional(),
  imageWidth: z.number().int().min(1).max(20_000).optional(),
  imageHeight: z.number().int().min(1).max(20_000).optional(),
  rowCount: z.number().int().min(0).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  sheetCount: z.number().int().min(0).optional(),
  sheets: z.array(attachmentSheetSchema).optional().default([]),
  textContent: z.string().max(1_000_000).optional(),
  blocks: z.array(attachmentBlockSchema).optional().default([]),
});

const historyItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1),
  toolCalls: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        status: toolCallStatusSchema,
        summary: z.string().trim().min(1),
      }),
    )
    .optional(),
  pendingActionId: z.string().optional(),
  pendingActionName: z.string().optional(),
  pendingActionStatus: pendingActionStatusSchema.optional(),
});

export const aiChatBodySchema = z.object({
  prompt: z.string().optional().default(''),
  conversationId: z.string().optional().default(''),
  attachments: z.array(attachmentSchema).optional().default([]),
  history: z.array(historyItemSchema).optional().default([]),
});

export const aiImportBodySchema = z.object({
  fileName: z.string().trim().min(1),
  target: z.enum(['auto', 'customer', 'product', 'order']).optional().default('auto'),
  rows: z.array(z.record(z.string(), z.unknown())),
});

export const aiActionParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const ragRebuildSchema = z.object({
  force: z.boolean().optional().default(false),
  incremental: z.boolean().optional().default(true),
});

export const ragDocumentKeyParamsSchema = z.object({
  key: z.string().trim().min(1).max(1024),
});

export const ragDocumentPatchSchema = z
  .object({
    content: z.string().max(2_000_000).optional(),
    includeInAssistant: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: '至少提供一个可更新字段',
  });

export const ragDocumentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  content: z.string().max(2_000_000),
  targetDir: z.string().trim().max(260).optional(),
  overwrite: z.boolean().optional().default(true),
  includeInAssistant: z.boolean().optional(),
});

const urlOrEmptyStringSchema = z.union([z.literal(''), z.string().trim().url().max(320)]);
const modelOrEmptyStringSchema = z.union([z.literal(''), z.string().trim().min(1).max(160)]);

export const aiRuntimeConfigPatchSchema = z
  .object({
    provider: z.enum(['deepseek', 'openai', 'gemini']).optional(),
    deepseekApiKey: z.string().max(4096).nullable().optional(),
    deepseekBaseUrl: z.string().trim().url().max(320).optional(),
    deepseekModel: z.string().trim().min(1).max(160).optional(),
    openaiApiKey: z.string().max(4096).nullable().optional(),
    openaiBaseUrl: z.string().trim().url().max(320).optional(),
    openaiModel: z.string().trim().min(1).max(160).optional(),
    geminiApiKey: z.string().max(4096).nullable().optional(),
    geminiBaseUrl: z.string().trim().url().max(320).optional(),
    geminiModel: z.string().trim().min(1).max(160).optional(),
    tavilyApiKey: z.string().max(4096).nullable().optional(),
    tavilyBaseUrl: z.string().trim().url().max(320).optional(),
    tavilyTopic: z.enum(['general', 'news']).optional(),
    tavilyMaxResults: z.number().int().min(1).max(8).optional(),
    smallProvider: z.enum(['deepseek', 'openai', 'gemini']).optional(),
    smallApiKey: z.string().max(4096).nullable().optional(),
    smallBaseUrl: urlOrEmptyStringSchema.optional(),
    smallModel: modelOrEmptyStringSchema.optional(),
    largeProvider: z.enum(['deepseek', 'openai', 'gemini']).optional(),
    largeApiKey: z.string().max(4096).nullable().optional(),
    largeBaseUrl: urlOrEmptyStringSchema.optional(),
    largeModel: modelOrEmptyStringSchema.optional(),
    layeredAgentEnabled: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: '至少提供一个可更新字段',
  });

const queryStringSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      return value[0];
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim();
    return normalized || undefined;
  },
  z.string().optional(),
);

const queryNumberSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      return value[0];
    }
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
  },
  z.number().int().min(1).max(100).optional(),
);

const profileArrayFieldSchema = z
  .array(z.string().trim().min(1).max(80))
  .max(12)
  .nullable()
  .optional();

const profileStringFieldSchema = z.string().trim().min(1).max(80).nullable().optional();

export const aiMemoryProfileQuerySchema = z.object({
  scope: z.enum(['effective', 'global', 'tenant', 'user', 'session']).optional().default('effective'),
  tenantId: queryStringSchema,
  userId: queryStringSchema,
  sessionId: queryStringSchema,
});

export const aiMemoryFactsQuerySchema = z.object({
  scope: z.enum(['user', 'tenant', 'session']).optional().default('user'),
  tenantId: queryStringSchema,
  userId: queryStringSchema,
  sessionId: queryStringSchema,
  limit: queryNumberSchema.default(20),
});

export const aiMemoryFactParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const aiMemoryFactDeleteBodySchema = z.object({
  id: z.string().trim().min(1),
  scope: z.enum(['user', 'tenant', 'session']).optional().default('user'),
  tenantId: queryStringSchema,
  userId: queryStringSchema,
  sessionId: queryStringSchema,
});

export const aiMemoryProfilePatchSchema = z
  .object({
    scope: z.enum(['global', 'tenant', 'user', 'session']).optional().default('user'),
    tenantId: z.string().trim().min(1).max(80).optional(),
    userId: z.string().trim().min(1).max(80).optional(),
    sessionId: z.string().trim().min(1).max(120).optional(),
    patch: z.object({
      assistantDisplayName: profileStringFieldSchema,
      assistantAliases: profileArrayFieldSchema,
      userPreferredName: profileStringFieldSchema,
      language: z.string().trim().min(1).max(24).nullable().optional(),
      stylePreferences: profileArrayFieldSchema,
    }),
  })
  .refine(
    (input) =>
      Object.values(input.patch).some((value) => value !== undefined),
    {
      message: 'patch 至少包含一个可更新字段',
      path: ['patch'],
    },
  );

export function parseAiChatBody(body: unknown) {
  const payload = parseWithSchema(aiChatBodySchema, body, 'ai-chat');

  const sanitizeRows = (rows: unknown[]) =>
    rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));

  const sanitizeSheets = (sheets: z.infer<typeof attachmentSheetSchema>[]) =>
    sheets
      .map((sheet) => {
        const rows = sanitizeRows(sheet.rows);
        return {
          name: sheet.name.trim(),
          rowCount: typeof sheet.rowCount === 'number' ? sheet.rowCount : rows.length,
          headers: sheet.headers.map((header) => header.trim()).filter(Boolean),
          rows,
        };
      })
      .filter((sheet) => sheet.name);

  const flattenSheetRows = (sheets: ReturnType<typeof sanitizeSheets>) =>
    sheets.flatMap((sheet) =>
      sheet.rows.map((row) => ({
        ...row,
        sheetName: typeof row.sheetName === 'string' && row.sheetName ? row.sheetName : sheet.name,
      })),
    );

  const attachments = payload.attachments
    .map((item) => {
      const safeRows = sanitizeRows(item.rows);
      const safeSheets = sanitizeSheets(item.sheets);
      const effectiveRows = safeRows.length > 0 ? safeRows : flattenSheetRows(safeSheets);
      const safeBlocks = item.blocks
        .map((block) => ({
          blockId: block.blockId.trim(),
          type: block.type,
          text: block.text.trim(),
          title: block.title?.trim() || undefined,
          locator: { ...block.locator },
        }))
        .filter((block) => block.text);
      const textContent = item.textContent?.trim() || undefined;

      if (!item.fileName.trim()) {
        return null;
      }
      if (effectiveRows.length === 0 && safeBlocks.length === 0 && !textContent && !item.imageDataUrl?.trim()) {
        return null;
      }

      return {
        id: item.id?.trim() || undefined,
        fileName: item.fileName.trim(),
        target: item.target || 'auto',
        kind:
          item.kind ||
          (item.imageDataUrl
            ? 'image'
            : safeSheets.length > 1
              ? 'workbook'
              : effectiveRows.length > 0
                ? 'table'
                : 'document'),
        mimeType: item.mimeType?.trim() || undefined,
        imageDataUrl: item.imageDataUrl?.trim() || undefined,
        imageWidth: typeof item.imageWidth === 'number' ? item.imageWidth : undefined,
        imageHeight: typeof item.imageHeight === 'number' ? item.imageHeight : undefined,
        rowCount: typeof item.rowCount === 'number' ? item.rowCount : effectiveRows.length,
        rows: effectiveRows,
        sheetCount: typeof item.sheetCount === 'number' ? item.sheetCount : safeSheets.length,
        sheets: safeSheets,
        textContent,
        blocks: safeBlocks,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const history = payload.history
    .map((item) => ({
      role: item.role,
      content: item.content.trim(),
      toolCalls:
        item.toolCalls && item.toolCalls.length > 0
          ? item.toolCalls.map((toolCall) => ({
              name: toolCall.name,
              status: toolCall.status,
              summary: toolCall.summary,
            }))
          : undefined,
      pendingActionId: item.pendingActionId?.trim() || undefined,
      pendingActionName: item.pendingActionName?.trim() || undefined,
      pendingActionStatus: item.pendingActionStatus,
    }))
    .slice(-8);

  return {
    prompt: payload.prompt.trim(),
    conversationId: payload.conversationId.trim(),
    attachments,
    history,
  };
}

export function parseAiMemoryProfileQuery(query: unknown) {
  return parseWithSchema(aiMemoryProfileQuerySchema, query, 'ai-memory-profile-query');
}

export function parseAiMemoryFactsQuery(query: unknown) {
  return parseWithSchema(aiMemoryFactsQuerySchema, query, 'ai-memory-facts-query');
}

export function parseAiMemoryProfileBody(body: unknown) {
  return parseWithSchema(aiMemoryProfileQuerySchema, body, 'internal-agent-memory-profile');
}

export function parseAiMemoryFactsBody(body: unknown) {
  return parseWithSchema(aiMemoryFactsQuerySchema, body, 'internal-agent-memory-facts');
}

export function parseAiMemoryProfilePatch(body: unknown) {
  return parseWithSchema(aiMemoryProfilePatchSchema, body, 'ai-memory-profile-patch');
}

export function parseAiMemoryFactDeleteBody(body: unknown) {
  return parseWithSchema(aiMemoryFactDeleteBodySchema, body, 'internal-agent-memory-fact-delete');
}

export type AiMemoryProfileScopeInput = Pick<
  z.infer<typeof aiMemoryProfileQuerySchema>,
  'scope' | 'tenantId' | 'userId' | 'sessionId'
>;

export type AiMemoryFactsScopeInput = Pick<
  z.infer<typeof aiMemoryFactsQuerySchema>,
  'scope' | 'tenantId' | 'userId' | 'sessionId'
>;

export function validateMemoryProfileScopeIdentity(input: AiMemoryProfileScopeInput) {
  if (input.scope === 'tenant' && !input.tenantId) {
    return 'tenant';
  }
  if ((input.scope === 'user' || input.scope === 'session') && !input.userId) {
    return 'user';
  }
  if (input.scope === 'session' && !input.sessionId) {
    return 'session';
  }
  return null;
}

export function validateMemoryFactsScopeIdentity(input: AiMemoryFactsScopeInput) {
  if (input.scope === 'tenant' && !input.tenantId) {
    return 'tenant';
  }
  if (input.scope === 'user' && !input.userId) {
    return 'user';
  }
  if (input.scope === 'session') {
    if (!input.userId) {
      return 'user';
    }
    if (!input.sessionId) {
      return 'session';
    }
  }
  return null;
}

