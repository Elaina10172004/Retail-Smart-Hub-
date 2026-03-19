import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuthenticatedUser, getSession } from '../../shared/auth';
import { parseWithSchema } from '../../shared/validation';
import { buildModelToolDefinitions, executeRuntimeToolCall } from './tool-runtime.service';
import { buildSkillContext, matchSkillsForPrompt } from './skill.service';
import { buildAttachmentContext, processDocumentSkill } from './import.service';
import { captureConversationMemory, deleteConversationMemoryFact, listConversationMemoryFacts } from './rag.service';
import { getProfileMemory, getProfileMemoryByScope, upsertProfileMemory } from './profile-memory.service';
import {
  parseAiMemoryFactDeleteBody,
  parseAiMemoryFactsBody,
  parseAiMemoryProfileBody,
  validateMemoryFactsScopeIdentity,
  validateMemoryProfileScopeIdentity,
} from './ai.validators';
import { normalizeScopedIdentity, resolveTenantId } from './ai.routes.shared';

const toolSchemaRequestSchema = z.object({
  token: z.string().optional().default(''),
});

const toolExecuteRequestSchema = z.object({
  toolName: z.string().trim().min(1),
  rawArguments: z.string().optional(),
  request: z.object({
    prompt: z.string().trim().max(4000).optional().default(''),
    userId: z.string().trim().min(1),
    tenantId: z.string().trim().optional(),
    sessionId: z.string().trim().optional(),
    username: z.string().trim().min(1),
    permissions: z.array(z.string()).optional().default([]),
    token: z.string().optional().default(''),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1),
          toolCalls: z
            .array(
              z.object({
                name: z.string().trim().min(1),
                status: z.enum(['planned', 'disabled', 'completed', 'awaiting_confirmation', 'cancelled', 'reverted']),
                summary: z.string().trim().min(1),
              }),
            )
            .optional(),
          pendingActionId: z.string().trim().optional(),
          pendingActionName: z.string().trim().optional(),
          pendingActionStatus: z.enum(['pending', 'confirmed', 'cancelled', 'undone', 'expired']).optional(),
        }),
      )
      .optional(),
  }),
});

const skillsMatchRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  token: z.string().optional().default(''),
  limit: z.coerce.number().int().min(1).max(8).optional().default(4),
});

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

const documentAttachmentSchema = z.object({
  id: z.string().trim().optional(),
  fileName: z.string().trim().min(1),
  target: z.enum(['auto', 'customer', 'product', 'order']).optional().default('auto'),
  kind: attachmentKindSchema.optional(),
  mimeType: z.string().trim().max(200).optional(),
  imageDataUrl: z.string().max(8_000_000).optional(),
  imageWidth: z.number().int().min(1).max(20_000).optional(),
  imageHeight: z.number().int().min(1).max(20_000).optional(),
  rowCount: z.number().int().min(0).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  sheetCount: z.number().int().min(0).optional(),
  sheets: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        rowCount: z.number().int().min(0).optional(),
        headers: z.array(z.string().trim().min(1)).optional().default([]),
        rows: z.array(z.record(z.string(), z.unknown())).optional().default([]),
      }),
    )
    .optional()
    .default([]),
  textContent: z.string().max(1_000_000).optional(),
  blocks: z
    .array(
      z.object({
        blockId: z.string().trim().min(1),
        type: z.enum(['paragraph', 'heading', 'page', 'sheet_summary', 'table_summary']).optional().default('paragraph'),
        text: z.string().trim().min(1).max(50_000),
        title: z.string().trim().max(500).optional(),
        locator: attachmentLocatorSchema.optional().default({}),
      }),
    )
    .optional()
    .default([]),
});

const documentHandleRequestSchema = z.object({
  prompt: z.string().optional().default(''),
  attachments: z.array(documentAttachmentSchema).optional().default([]),
  token: z.string().optional().default(''),
});

const documentContextRequestSchema = z.object({
  prompt: z.string().optional().default(''),
  attachments: z.array(documentAttachmentSchema).optional().default([]),
});

const memoryProfilePatchRequestSchema = z.object({
  scope: z.enum(['global', 'tenant', 'user', 'session']),
  token: z.string().optional().default(''),
  tenantId: z.string().trim().optional(),
  userId: z.string().trim().optional(),
  sessionId: z.string().trim().optional(),
  patch: z.record(z.string(), z.unknown()).default({}),
});

const memoryCaptureRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  reply: z.string().trim().min(1),
  token: z.string().optional().default(''),
  sessionId: z.string().trim().optional(),
  citations: z.array(z.string()).optional().default([]),
});

function isLocalIp(rawIp: string | undefined) {
  if (!rawIp) {
    return false;
  }
  const ip = rawIp.replace('::ffff:', '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function isLocalRequest(req: { ip?: string; socket?: { remoteAddress?: string | null } }) {
  return isLocalIp(req.ip) || isLocalIp(req.socket?.remoteAddress || undefined);
}

function hasValidAgentKey(value: string | undefined) {
  return Boolean(value) && value === env.aiAgentSharedKey;
}

function resolveInternalSession(token: string) {
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }
  return getSession(normalized);
}

function rejectMissingSession(res: { status: (code: number) => { json: (body: unknown) => unknown } }) {
  return res.status(401).json({
    ok: false,
    code: 'unauthorized',
    message: 'missing or invalid auth token',
  });
}

function resolveScopedIdentityFromSession(
  sessionUser: Pick<AuthenticatedUser, 'id' | 'department' | 'permissions'>,
  input: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
  },
) {
  return normalizeScopedIdentity({
    requestedTenantId: input.tenantId,
    requestedUserId: input.userId,
    requestedSessionId: input.sessionId,
    authTenantId: resolveTenantId(sessionUser.department),
    authUserId: sessionUser.id,
    permissions: sessionUser.permissions,
  });
}

export const agentInternalRouter = Router();

agentInternalRouter.use((req, res, next) => {
  const keyHeader = req.headers['x-agent-key'];
  const agentKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;

  if (!hasValidAgentKey(agentKey)) {
    return res.status(403).json({
      ok: false,
      code: 'forbidden',
      message: 'invalid agent key',
    });
  }

  if (!isLocalRequest(req)) {
    return res.status(403).json({
      ok: false,
      code: 'forbidden',
      message: 'non-local caller is not allowed',
    });
  }

  next();
});

agentInternalRouter.get('/health', (_req, res) => {
  return res.json({
    ok: true,
    service: 'node-agent-bridge',
    runtime: env.aiRuntime,
  });
});

agentInternalRouter.post('/tools/schema', (req, res) => {
  const payload = parseWithSchema(toolSchemaRequestSchema, req.body, 'internal-agent-tools-schema');
  const session = resolveInternalSession(payload.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const tools = buildModelToolDefinitions(session.user.permissions);

  return res.json({
    ok: true,
    tools,
  });
});

agentInternalRouter.post('/tools/execute', (req, res) => {
  const payload = parseWithSchema(toolExecuteRequestSchema, req.body, 'internal-agent-tools-execute');

  const session = resolveInternalSession(payload.request.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }

  const execution = executeRuntimeToolCall(payload.toolName, payload.rawArguments, {
    prompt: payload.request.prompt,
    userId: session.user.id,
    tenantId: resolveTenantId(session.user.department),
    sessionId: session.sessionId,
    username: session.user.username,
    permissions: session.user.permissions,
    token: session.token,
    history: payload.request.history,
  });

  return res.json({
    ok: true,
    execution,
  });
});

agentInternalRouter.post('/skills/match', (req, res) => {
  const payload = parseWithSchema(skillsMatchRequestSchema, req.body, 'internal-agent-skills-match');
  const session = resolveInternalSession(payload.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const matched = matchSkillsForPrompt({
    prompt: payload.prompt,
    permissions: session.user.permissions,
    limit: payload.limit,
  });
  const context = buildSkillContext(matched.matchedSkills);

  return res.json({
    ok: true,
    matchedSkills: matched.matchedSkills,
    availableSkillCount: matched.availableSkillCount,
    disabledSkillCount: matched.disabledSkillCount,
    context,
  });
});

agentInternalRouter.post('/document/handle', (req, res) => {
  const payload = parseWithSchema(documentHandleRequestSchema, req.body, 'internal-agent-document-handle');
  const session = resolveInternalSession(payload.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const result = processDocumentSkill({
    prompt: payload.prompt,
    attachments: payload.attachments,
    userId: session.user.id,
    username: session.user.username,
    permissions: session.user.permissions,
  });

  return res.json({
    ok: true,
    result,
  });
});

agentInternalRouter.post('/document/context', (req, res) => {
  const payload = parseWithSchema(documentContextRequestSchema, req.body, 'internal-agent-document-context');
  const context = buildAttachmentContext(payload.attachments);
  return res.json({
    ok: true,
    context,
  });
});

agentInternalRouter.post('/memory/profile', (req, res) => {
  const sessionToken = parseWithSchema(
    z.object({ token: z.string().optional().default('') }),
    req.body,
    'internal-agent-memory-profile-token',
  );
  const session = resolveInternalSession(sessionToken.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const payload = parseAiMemoryProfileBody(req.body);
  const identity = resolveScopedIdentityFromSession(session.user, {
    tenantId: payload.tenantId,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });
  const resolvedScope = {
    scope: payload.scope,
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
  };
  const invalidProfileScope = validateMemoryProfileScopeIdentity(resolvedScope);
  if (invalidProfileScope) {
    const requiredField = invalidProfileScope === 'tenant' ? 'tenantId' : invalidProfileScope === 'user' ? 'userId' : 'sessionId';
    return res.status(400).json({
      ok: false,
      code: 'invalid_scope_identity',
      message: `${requiredField} is required for ${payload.scope} scope`,
    });
  }
  const result =
    payload.scope === 'effective'
      ? getProfileMemory({
          tenantId: identity.tenantId,
          userId: identity.userId,
          sessionId: identity.sessionId,
        })
      : getProfileMemoryByScope({
          scope: payload.scope,
          tenantId: identity.tenantId,
          userId: identity.userId,
          sessionId: identity.sessionId,
        });
  return res.json({
    ok: true,
    result,
  });
});

agentInternalRouter.post('/memory/facts', (req, res) => {
  const sessionToken = parseWithSchema(
    z.object({ token: z.string().optional().default('') }),
    req.body,
    'internal-agent-memory-facts-token',
  );
  const session = resolveInternalSession(sessionToken.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const payload = parseAiMemoryFactsBody(req.body);
  const identity = resolveScopedIdentityFromSession(session.user, {
    tenantId: payload.tenantId,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });
  const invalidFactsScope = validateMemoryFactsScopeIdentity({
    scope: payload.scope,
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
  });
  if (invalidFactsScope) {
    const requiredField = invalidFactsScope === 'tenant' ? 'tenantId' : invalidFactsScope === 'user' ? 'userId' : 'sessionId';
    return res.status(400).json({
      ok: false,
      code: 'invalid_scope_identity',
      message: `${requiredField} is required for ${payload.scope} scope`,
    });
  }

  const facts =
    payload.scope === 'tenant'
      ? listConversationMemoryFacts({
          tenantId: identity.tenantId,
          limit: payload.limit,
        })
      : payload.scope === 'session'
        ? listConversationMemoryFacts({
            tenantId: identity.tenantId,
            userId: identity.userId,
            sessionId: identity.sessionId,
            limit: payload.limit,
          })
        : listConversationMemoryFacts({
            tenantId: identity.tenantId,
            userId: identity.userId,
            limit: payload.limit,
          });

  return res.json({
    ok: true,
    result: {
      facts,
    },
  });
});

agentInternalRouter.post('/memory/profile/patch', (req, res) => {
  const payload = parseWithSchema(memoryProfilePatchRequestSchema, req.body, 'internal-agent-memory-profile-patch');
  const session = resolveInternalSession(payload.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const identity = resolveScopedIdentityFromSession(session.user, {
    tenantId: payload.tenantId,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });
  if ((payload.scope === 'global' || payload.scope === 'tenant') && !identity.canManageCrossScope) {
    return res.status(403).json({
      ok: false,
      code: 'forbidden',
      message: 'settings.access-control permission is required',
    });
  }
  const invalidPatchScope = validateMemoryProfileScopeIdentity({
    scope: payload.scope,
    tenantId:
      payload.scope === 'tenant' || payload.scope === 'user' || payload.scope === 'session'
        ? identity.tenantId
        : undefined,
    userId: payload.scope === 'user' || payload.scope === 'session' ? identity.userId : undefined,
    sessionId: payload.scope === 'session' ? identity.sessionId : undefined,
  });
  if (invalidPatchScope) {
    const requiredField = invalidPatchScope === 'tenant' ? 'tenantId' : invalidPatchScope === 'user' ? 'userId' : 'sessionId';
    return res.status(400).json({
      ok: false,
      code: 'invalid_scope_identity',
      message: `${requiredField} is required for ${payload.scope} scope`,
    });
  }
  const record = upsertProfileMemory({
    scope: payload.scope,
    tenantId:
      payload.scope === 'tenant' || payload.scope === 'user' || payload.scope === 'session'
        ? identity.tenantId
        : undefined,
    userId: payload.scope === 'user' || payload.scope === 'session' ? identity.userId : undefined,
    sessionId: payload.scope === 'session' ? identity.sessionId : undefined,
    patch: payload.patch,
    updatedBy: session.user.username,
    lastConfirmedAt: new Date().toISOString(),
  });
  const effective = getProfileMemory({
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
  });
  return res.json({
    ok: true,
    result: {
      ...effective,
      _recordVersion: record.version,
    },
  });
});

agentInternalRouter.post('/memory/facts/delete', (req, res) => {
  const sessionToken = parseWithSchema(
    z.object({ token: z.string().optional().default('') }),
    req.body,
    'internal-agent-memory-facts-delete-token',
  );
  const session = resolveInternalSession(sessionToken.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const payload = parseAiMemoryFactDeleteBody(req.body);
  const identity = resolveScopedIdentityFromSession(session.user, {
    tenantId: payload.tenantId,
    userId: payload.userId,
    sessionId: payload.sessionId,
  });
  const invalidDeleteScope = validateMemoryFactsScopeIdentity({
    scope: payload.scope,
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
  });
  if (invalidDeleteScope) {
    const requiredField = invalidDeleteScope === 'tenant' ? 'tenantId' : invalidDeleteScope === 'user' ? 'userId' : 'sessionId';
    return res.status(400).json({
      ok: false,
      code: 'invalid_scope_identity',
      message: `${requiredField} is required for ${payload.scope} scope`,
    });
  }
  if (payload.id.startsWith('profile:')) {
    const target = payload.id.slice('profile:'.length).trim();
    if (!target) {
      return res.json({
        ok: true,
        result: { deleted: false, removed: 0, reason: 'invalid_profile_target' },
      });
    }
    upsertProfileMemory({
      scope: 'user',
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId: identity.sessionId,
      patch: { [target]: null },
      updatedBy: session.user.username,
      lastConfirmedAt: new Date().toISOString(),
    });
    return res.json({
      ok: true,
      result: { deleted: true, removed: 1 },
    });
  }

  const deleted = deleteConversationMemoryFact({
    id: payload.id,
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: payload.scope === 'session' ? identity.sessionId : undefined,
  });
  return res.json({
    ok: true,
    result: deleted.deleted
      ? { deleted: true, removed: 1, id: payload.id }
      : { deleted: false, removed: 0, reason: deleted.reason || 'not_found' },
  });
});

agentInternalRouter.post('/memory/capture', (req, res) => {
  const payload = parseWithSchema(memoryCaptureRequestSchema, req.body, 'internal-agent-memory-capture');
  const session = resolveInternalSession(payload.token || '');
  if (!session) {
    return rejectMissingSession(res);
  }
  const result = captureConversationMemory({
    prompt: payload.prompt,
    reply: payload.reply,
    userId: session.user.id,
    tenantId: resolveTenantId(session.user.department),
    sessionId: payload.sessionId,
    citations: payload.citations,
  });
  return res.json({
    ok: true,
    result,
  });
});
