import type { Router } from 'express';
import { cancelPendingAction, confirmPendingAction, getPendingAction, undoConfirmedAction } from './action.service';
import { aiActionParamsSchema } from './ai.validators';
import { parseWithSchema } from '../../shared/validation';
import { isApiError } from '../../shared/api-error';
import { fail, ok } from '../../shared/response';

export function registerAiActionRoutes(aiRouter: Router) {
  aiRouter.post('/actions/:id/confirm', (req, res) => {
    try {
      const params = parseWithSchema(aiActionParamsSchema, req.params, 'ai-action-params');
      const result = confirmPendingAction(
        params.id,
        req.auth?.id || '',
        req.auth?.username || 'unknown',
        req.auth?.permissions || [],
      );

      return ok(res, result, 'AI 待确认操作已执行。');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Confirm AI action failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.get('/actions/:id', (req, res) => {
    try {
      const params = parseWithSchema(aiActionParamsSchema, req.params, 'ai-action-params');
      const result = getPendingAction(params.id, req.auth?.id || '');
      return ok(res, result);
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Get AI action failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.post('/actions/:id/cancel', (req, res) => {
    try {
      const params = parseWithSchema(aiActionParamsSchema, req.params, 'ai-action-params');
      const result = cancelPendingAction(
        params.id,
        req.auth?.id || '',
        req.auth?.username || 'unknown',
        req.auth?.permissions || [],
      );

      return ok(res, result, 'AI 待确认操作已取消。');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Cancel AI action failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });

  aiRouter.post('/actions/:id/undo', (req, res) => {
    try {
      const params = parseWithSchema(aiActionParamsSchema, req.params, 'ai-action-params');
      const result = undoConfirmedAction(
        params.id,
        req.auth?.id || '',
        req.auth?.username || 'unknown',
        req.auth?.permissions || [],
      );

      return ok(res, result, 'AI 已执行操作已撤回。');
    } catch (error) {
      return fail(
        res,
        isApiError(error) ? error.status : 400,
        error instanceof Error ? error.message : 'Undo AI action failed',
        isApiError(error) ? error.code : undefined,
        isApiError(error) ? error.details : undefined,
      );
    }
  });
}
