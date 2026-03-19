import type { Router } from 'express';
import { appendAuditLog } from '../../database/db';
import { isApiError } from '../../shared/api-error';
import { fail, ok } from '../../shared/response';
import { parseWithSchema } from '../../shared/validation';
import { runWithAiRuntime } from './ai.runtime-facade';
import { deletePythonMemoryFact, getPythonMemoryFacts, getPythonMemoryProfile, patchPythonMemoryProfile } from './python-agent.client';
import {
  aiMemoryFactParamsSchema,
  parseAiMemoryFactsQuery,
  parseAiMemoryProfilePatch,
  parseAiMemoryProfileQuery,
  validateMemoryFactsScopeIdentity,
  validateMemoryProfileScopeIdentity,
} from './ai.validators';
import { memoryNotes, normalizeScopedIdentity, resolveTenantId } from './ai.routes.shared';

interface AiMemoryFactDto {
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

function toOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toFiniteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeMemoryFacts(rawFacts: unknown[], fallbackUserId?: string): AiMemoryFactDto[] {
  const now = new Date().toISOString();
  return rawFacts
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }

      const payload = item as Record<string, unknown>;
      const id = toOptionalString(payload.id) || toOptionalString(payload.factId);
      if (!id) {
        return null;
      }

      const title = toOptionalString(payload.title) || toOptionalString(payload.target) || 'memory fact';
      const content = toOptionalString(payload.content) || toOptionalString(payload.value) || '';
      const createdAt = toOptionalString(payload.createdAt) || toOptionalString(payload.updatedAt) || now;
      const tier = toOptionalString(payload.tier);
      const normalizedTier: AiMemoryFactDto['tier'] =
        tier === 'working' || tier === 'episodic' || tier === 'semantic' || tier === 'archive' ? tier : 'semantic';
      const lastAccessAt = toOptionalString(payload.lastAccessAt) || toOptionalString(payload.updatedAt) || createdAt;

      return {
        id,
        userId: toOptionalString(payload.userId) || fallbackUserId || 'unknown',
        tenantId: toOptionalString(payload.tenantId),
        sessionId: toOptionalString(payload.sessionId),
        title,
        content,
        createdAt,
        tier: normalizedTier,
        importance: toFiniteNumber(payload.importance, 0.5),
        reinforcedCount: Math.max(1, Math.floor(toFiniteNumber(payload.reinforcedCount, 1))),
        lastAccessAt,
        lastReinforcedAt: toOptionalString(payload.lastReinforcedAt),
        tags: Array.isArray(payload.tags) ? payload.tags.filter((value): value is string => typeof value === 'string') : [],
      } satisfies AiMemoryFactDto;
    })
    .filter((item) => item !== null) as AiMemoryFactDto[];
}

export function registerAiMemoryRoutes(aiRouter: Router) {
  aiRouter.get('/memory/profile', async (req, res) => {
    try {
      const query = parseAiMemoryProfileQuery(req.query);
      const permissions = req.auth?.permissions || [];
      const identity = normalizeScopedIdentity({
        requestedTenantId: query.tenantId,
        requestedUserId: query.userId,
        requestedSessionId: query.sessionId,
        authTenantId: resolveTenantId(req.auth?.department),
        authUserId: req.auth?.id || undefined,
        permissions,
      });

      const targetScope = query.scope;
      const invalidProfileScope = validateMemoryProfileScopeIdentity({
        scope: targetScope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: identity.sessionId,
      });
      if (invalidProfileScope) {
        const requiredField = invalidProfileScope === 'tenant' ? 'tenantId' : invalidProfileScope === 'user' ? 'userId' : 'sessionId';
        return fail(res, 400, `${requiredField} is required for ${targetScope} scope`);
      }

      const resolved = await runWithAiRuntime(
        'memory_profile',
        async () =>
          getPythonMemoryProfile({
            token: req.auth?.token || '',
            scope: targetScope,
            tenantId: identity.tenantId,
            userId: identity.userId,
            sessionId: identity.sessionId,
          }),
      );
      const profilePayload = resolved.data as {
        profile: unknown;
        records: unknown[];
        version?: number;
        updatedAt?: string;
        updatedBy?: string;
        lastConfirmedAt?: string;
      };
      return ok(res, {
        scope: targetScope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: identity.sessionId,
        profile: profilePayload.profile,
        records: profilePayload.records,
        version: profilePayload.version || 1,
        updatedAt: profilePayload.updatedAt || new Date().toISOString(),
        updatedBy: profilePayload.updatedBy || 'unknown',
        lastConfirmedAt: profilePayload.lastConfirmedAt,
        priorityOrder: ['session', 'user', 'tenant', 'global'] as const,
        notes: memoryNotes,
      });
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Get memory profile failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.get('/memory/facts', async (req, res) => {
    try {
      const query = parseAiMemoryFactsQuery(req.query);
      const permissions = req.auth?.permissions || [];
      const identity = normalizeScopedIdentity({
        requestedTenantId: query.tenantId,
        requestedUserId: query.userId,
        requestedSessionId: query.sessionId,
        authTenantId: resolveTenantId(req.auth?.department),
        authUserId: req.auth?.id || undefined,
        permissions,
      });
      const invalidFactsScope = validateMemoryFactsScopeIdentity({
        scope: query.scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: identity.sessionId,
      });
      if (invalidFactsScope) {
        const requiredField = invalidFactsScope === 'tenant' ? 'tenantId' : invalidFactsScope === 'user' ? 'userId' : 'sessionId';
        return fail(res, 400, `${requiredField} is required for ${query.scope} scope`);
      }

      const resolved = await runWithAiRuntime(
        'memory_facts',
        async () =>
          getPythonMemoryFacts({
            token: req.auth?.token || '',
            scope: query.scope,
            tenantId: identity.tenantId,
            userId: identity.userId,
            sessionId: identity.sessionId,
            limit: query.limit,
          }),
      );
      const factsPayload = (resolved.data as { facts?: unknown[] }).facts || [];
      const facts = normalizeMemoryFacts(factsPayload, identity.userId);

      return ok(res, {
        scope: query.scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: identity.sessionId,
        limit: query.limit,
        facts,
      });
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'List memory facts failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.patch('/memory/profile', async (req, res) => {
    try {
      const payload = parseAiMemoryProfilePatch(req.body);
      const permissions = req.auth?.permissions || [];
      const identity = normalizeScopedIdentity({
        requestedTenantId: payload.tenantId,
        requestedUserId: payload.userId,
        requestedSessionId: payload.sessionId,
        authTenantId: resolveTenantId(req.auth?.department),
        authUserId: req.auth?.id || undefined,
        permissions,
      });

      if ((payload.scope === 'global' || payload.scope === 'tenant') && !identity.canManageCrossScope) {
        return fail(res, 403, 'Permission denied: settings.access-control');
      }
      const invalidPatchScope = validateMemoryProfileScopeIdentity({
        scope: payload.scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: identity.sessionId,
      });
      if (invalidPatchScope) {
        const requiredField = invalidPatchScope === 'tenant' ? 'tenantId' : invalidPatchScope === 'user' ? 'userId' : 'sessionId';
        return fail(res, 400, `${requiredField} is required for ${payload.scope} scope`);
      }
      const resolved = await runWithAiRuntime(
        'memory_profile_patch',
        async () =>
          patchPythonMemoryProfile({
            token: req.auth?.token || '',
            scope: payload.scope,
            tenantId:
              payload.scope === 'tenant' || payload.scope === 'user' || payload.scope === 'session'
                ? identity.tenantId
                : undefined,
            userId: payload.scope === 'user' || payload.scope === 'session' ? identity.userId : undefined,
            sessionId: payload.scope === 'session' ? identity.sessionId : undefined,
            patch: payload.patch,
            updatedBy: req.auth?.username || 'unknown',
          }),
      );
      const resolvedData = resolved.data as {
        profile: unknown;
        records: unknown[];
        version?: number;
        updatedAt?: string;
        updatedBy?: string;
        lastConfirmedAt?: string;
      };

      appendAuditLog('ai_memory_profile_patch', 'ai_memory_profile', 'python-profile-memory', {
        by: req.auth?.username || 'unknown',
        userId: req.auth?.id || 'anonymous',
        scope: payload.scope,
        tenantId: identity.tenantId,
        targetUserId: identity.userId,
        sessionId: identity.sessionId,
        patch: payload.patch,
        recordVersion: resolvedData.version || 1,
        runtimeUsed: resolved.runtimeUsed,
      });

      return ok(
        res,
        {
          scope: 'effective',
          tenantId: identity.tenantId,
          userId: identity.userId,
          sessionId: identity.sessionId,
          profile: resolvedData.profile,
          records: resolvedData.records,
          version: resolvedData.version || 1,
          updatedAt: resolvedData.updatedAt || new Date().toISOString(),
          updatedBy: resolvedData.updatedBy || (req.auth?.username || 'unknown'),
          lastConfirmedAt: resolvedData.lastConfirmedAt,
          priorityOrder: ['session', 'user', 'tenant', 'global'] as const,
          notes: memoryNotes,
        },
        'Memory profile updated.',
      );
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Patch memory profile failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.delete('/memory/facts/:id', async (req, res) => {
    try {
      const params = parseWithSchema(aiMemoryFactParamsSchema, req.params, 'ai-memory-fact-params');
      const query = parseAiMemoryFactsQuery(req.query);
      const permissions = req.auth?.permissions || [];
      const identity = normalizeScopedIdentity({
        requestedTenantId: query.tenantId,
        requestedUserId: query.userId,
        requestedSessionId: query.sessionId,
        authTenantId: resolveTenantId(req.auth?.department),
        authUserId: req.auth?.id || undefined,
        permissions,
      });

      const resolved = await runWithAiRuntime(
        'memory_fact_delete',
        async () =>
          deletePythonMemoryFact({
            token: req.auth?.token || '',
            id: params.id,
            scope: query.scope,
            tenantId: identity.tenantId,
            userId: identity.userId,
            sessionId: identity.sessionId,
          }),
      );
      const result = resolved.data as { deleted: boolean; reason?: string; removed?: number };

      if (!result.deleted) {
        return fail(res, 404, `Memory fact delete failed: ${result.reason}`);
      }

      appendAuditLog('ai_memory_fact_delete', 'ai_memory_fact', params.id, {
        by: req.auth?.username || 'unknown',
        userId: req.auth?.id || 'anonymous',
        scope: query.scope,
        tenantId: identity.tenantId,
        targetUserId: identity.userId,
        sessionId: identity.sessionId,
        removed: result.removed,
        runtimeUsed: resolved.runtimeUsed,
      });

      return ok(res, result, 'Memory fact deleted.');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Delete memory fact failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });
}




