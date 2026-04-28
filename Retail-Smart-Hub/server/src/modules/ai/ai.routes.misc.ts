import type { Router } from 'express';
import { appendAuditLog } from '../../database/db';
import { isApiError } from '../../shared/api-error';
import { requirePermission } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import { parseWithSchema } from '../../shared/validation';
import { getAiStatusForRuntime } from './ai.service';
import { getAiStatusWithRuntime } from './ai.runtime-facade';
import { getSkillStats } from './skill.service';
import { getAiRuntimeConfigSnapshot, updateAiRuntimeConfig } from './ai.runtime-config.service';
import { restartPythonSidecar } from './python-sidecar.service';
import { aiImportBodySchema, aiRuntimeConfigPatchSchema } from './ai.validators';

export function registerAiMiscRoutes(aiRouter: Router) {
  aiRouter.get('/status', async (req, res) => {
    try {
      const status = await getAiStatusForRuntime(req.auth?.token || '');
      return ok(res, status);
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 500,
        error instanceof Error ? error.message : 'Get AI status failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  // Config management is admin-only; UI gating is not sufficient.
  aiRouter.get('/config', requirePermission('settings.access-control'), (req, res) => {
    try {
      return ok(res, getAiRuntimeConfigSnapshot());
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 500,
        error instanceof Error ? error.message : 'Get AI runtime config failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.patch('/config', requirePermission('settings.access-control'), async (req, res) => {
    try {
      const payload = parseWithSchema(aiRuntimeConfigPatchSchema, req.body, 'ai-runtime-config-patch');
      const config = updateAiRuntimeConfig({
        provider: payload.provider,
        deepseekApiKey: payload.deepseekApiKey,
        deepseekBaseUrl: payload.deepseekBaseUrl,
        deepseekModel: payload.deepseekModel,
        openaiApiKey: payload.openaiApiKey,
        openaiBaseUrl: payload.openaiBaseUrl,
        openaiModel: payload.openaiModel,
        geminiApiKey: payload.geminiApiKey,
        geminiBaseUrl: payload.geminiBaseUrl,
        geminiModel: payload.geminiModel,
        tavilyApiKey: payload.tavilyApiKey,
        tavilyBaseUrl: payload.tavilyBaseUrl,
        tavilyTopic: payload.tavilyTopic,
        tavilyMaxResults: payload.tavilyMaxResults,
        smallProvider: payload.smallProvider,
        smallApiKey: payload.smallApiKey,
        smallBaseUrl: payload.smallBaseUrl,
        smallModel: payload.smallModel,
        largeProvider: payload.largeProvider,
        largeApiKey: payload.largeApiKey,
        largeBaseUrl: payload.largeBaseUrl,
        largeModel: payload.largeModel,
      });

      await restartPythonSidecar();

      appendAuditLog('ai_runtime_config_patch', 'ai', req.auth?.id || 'anonymous', {
        by: req.auth?.username || 'unknown',
        runtime: config.runtime,
        provider: config.provider,
        activeModel: config.activeModel,
        hasApiKey: config.hasApiKey,
        smallProvider: config.smallModelProfile.provider,
        smallModel: config.smallModelProfile.model,
        largeProvider: config.largeModelProfile.provider,
        largeModel: config.largeModelProfile.model,
        deepseekBaseUrl: config.deepseekBaseUrl,
        deepseekModel: config.deepseekModel,
        openaiBaseUrl: config.openaiBaseUrl,
        openaiModel: config.openaiModel,
        geminiBaseUrl: config.geminiBaseUrl,
        geminiModel: config.geminiModel,
        tavilyEnabled: config.tavilyProfile.enabled,
        tavilyBaseUrl: config.tavilyBaseUrl,
        tavilyTopic: config.tavilyTopic,
        tavilyMaxResults: config.tavilyMaxResults,
        updatedAt: config.updatedAt,
      });

      return ok(res, config, 'AI 运行时配置已更新并重新加载。');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Update AI runtime config failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.get('/skills', async (req, res) => {
    const resolved = await getAiStatusWithRuntime(req.auth?.token || '');

    return ok(res, {
      enabled: true,
      mode: 'python-runtime',
      reason: 'Skill context is resolved by python runtime via internal node bridge.',
      stats: getSkillStats(),
    });
  });

  aiRouter.post('/import', (req, res) => {
    try {
      const payload = parseWithSchema(aiImportBodySchema, req.body, 'ai-import');

      appendAuditLog('ai_import_compat', 'ai', req.auth?.id || 'anonymous', {
        by: req.auth?.username || 'unknown',
        fileName: payload.fileName,
        target: payload.target,
        compatibilityMode: 'disabled-use-chat-attachments',
      });

      return fail(res, 410, 'Standalone import endpoint is disabled. Use AI chat with attachments instead.');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'AI import failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });
}



