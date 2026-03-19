import { Router } from 'express';
import { moduleCatalog } from '../../shared/module-catalog';
import {
  changePassword,
  createSession,
  confirmPasswordReset,
  getPasswordPolicySummary,
  getPasswordSecuritySummary,
  listUserSessions,
  requestPasswordReset,
  requireAuth,
  requirePermission,
  revokeOtherSessions,
  revokeSession,
  revokeSessionById,
  updateProfile,
  verifyCurrentPassword,
} from '../../shared/auth';
import { isApiError } from '../../shared/api-error';
import { fail, ok } from '../../shared/response';
import { parseWithSchema } from '../../shared/validation';
import {
  changePasswordSchema,
  loginPayloadSchema,
  recoverPasswordConfirmSchema,
  recoverPasswordRequestSchema,
  revokeSessionParamsSchema,
  updateProfileSchema,
  verifyPasswordSchema,
} from './system.validators';
import { listAuditLogs, listSystemNotifications } from './system.service';

export const systemRouter = Router();

function resolveAuthErrorStatus(error: unknown, fallbackStatus: number) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('频繁')) {
    return 429;
  }

  return fallbackStatus;
}

function verifySensitiveRequest(req: { body?: unknown; auth?: { id: string } }, res: Parameters<typeof fail>[0]) {
  try {
    const payload = parseWithSchema(verifyPasswordSchema, req.body, 'verifySensitiveRequest');
    verifyCurrentPassword(req.auth?.id || '', payload.verifyPassword);
    return true;
  } catch (error) {
    fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Sensitive operation verification failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
    return false;
  }
}

systemRouter.post('/login', (req, res) => {
  try {
    const payload = parseWithSchema(loginPayloadSchema, req.body, 'login');
    const session = createSession(payload.username, payload.password, {
      ipAddress: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
    });
    return ok(res, session, '登录成功。');
  } catch (error) {
    const status = isApiError(error) ? error.status : resolveAuthErrorStatus(error, 401);
    return fail(
      res,
      status,
      error instanceof Error ? error.message : 'Login failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

systemRouter.post('/recover-password/request', (req, res) => {
  try {
    const payload = parseWithSchema(recoverPasswordRequestSchema, req.body, 'recover-password-request');
    const result = requestPasswordReset(
      {
        username: payload.username,
        email: payload.email,
        phone: payload.phone,
      },
      {
        ipAddress: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
      }
    );
    const message =
      result.delivery === 'local-demo'
        ? '若账号信息匹配，系统已生成一次性重置令牌。本地或演示环境会直接返回令牌预览。'
        : '若账号信息匹配，系统已受理重置请求。当前未内置邮件或短信投递，生产环境请接入外部通道或由管理员发放临时口令。';
    return ok(res, result, message);
  } catch (error) {
    const status = isApiError(error) ? error.status : resolveAuthErrorStatus(error, 400);
    return fail(
      res,
      status,
      error instanceof Error ? error.message : 'Recover password request failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

systemRouter.post('/recover-password/confirm', (req, res) => {
  try {
    const payload = parseWithSchema(recoverPasswordConfirmSchema, req.body, 'recover-password-confirm');
    confirmPasswordReset(
      {
        resetToken: payload.resetToken,
        newPassword: payload.newPassword,
      },
      {
        ipAddress: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
      }
    );
    return ok(res, true, '密码已重置，请使用新密码登录。');
  } catch (error) {
    const status = isApiError(error) ? error.status : resolveAuthErrorStatus(error, 400);
    return fail(
      res,
      status,
      error instanceof Error ? error.message : 'Recover password failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

systemRouter.post('/recover-password', (_req, res) => {
  return fail(res, 410, 'recover-password endpoint has been replaced by /recover-password/request and /recover-password/confirm');
});

systemRouter.use(requireAuth);

systemRouter.get('/modules', (_req, res) => {
  return ok(res, moduleCatalog);
});

systemRouter.get('/session', (req, res) => {
  return ok(res, {
    token: req.auth?.token,
    sessionId: req.auth?.sessionId,
    user: req.auth && {
      id: req.auth.id,
      username: req.auth.username,
      email: req.auth.email,
      phone: req.auth.phone,
      department: req.auth.department,
      status: req.auth.status,
      mustChangePassword: req.auth.mustChangePassword,
      roles: req.auth.roles,
      permissions: req.auth.permissions,
    },
  });
});

systemRouter.post('/logout', (req, res) => {
  revokeSession(req.auth?.token || '');
  return ok(res, true, '已退出登录。');
});

systemRouter.post('/change-password', (req, res) => {
  try {
    const payload = parseWithSchema(changePasswordSchema, req.body, 'change-password');
    changePassword(req.auth?.id || '', payload.currentPassword, payload.newPassword, req.auth?.token || '');
    return ok(res, true, '密码已修改。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Change password failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

systemRouter.post('/profile', (req, res) => {
  try {
    const payload = parseWithSchema(updateProfileSchema, req.body, 'update-profile');
    updateProfile(req.auth?.id || '', {
      email: payload.email,
      phone: payload.phone,
      department: payload.department,
    });
    return ok(res, true, '个人资料已更新。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Update profile failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

systemRouter.get('/audit-logs', requirePermission('settings.access-control'), (req, res) => {
  const limit = Number(req.query.limit || 50);
  const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  return ok(res, listAuditLogs(Number.isFinite(limit) ? limit : 50, entityType, action));
});

systemRouter.get('/notifications', (req, res) => {
  const limit = Number(req.query.limit || 8);
  return ok(res, listSystemNotifications(Number.isFinite(limit) ? limit : 8, req.auth?.permissions ?? []));
});

systemRouter.get('/sessions', (req, res) => {
  return ok(res, {
    sessions: listUserSessions(req.auth?.id || '', req.auth?.token || ''),
    policy: getPasswordPolicySummary(),
    security: getPasswordSecuritySummary(req.auth?.id || ''),
  });
});

systemRouter.post('/sessions/revoke-others', (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }
  const revokedCount = revokeOtherSessions(req.auth?.id || '', req.auth?.token || '');
  return ok(res, { revokedCount }, `已移除 ${revokedCount} 个其他会话。`);
});

systemRouter.post('/sessions/:sessionId/revoke', (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }

  const params = parseWithSchema(revokeSessionParamsSchema, req.params, 'revoke-session');
  if (params.sessionId === req.auth?.sessionId) {
    return fail(res, 400, 'Current session cannot be revoked from this endpoint');
  }

  try {
    revokeSessionById(params.sessionId, req.auth?.id || '');
    return ok(res, true, '会话已移除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Revoke session failed');
  }
});

systemRouter.get('/summary', (_req, res) => {
  return ok(res, {
    frontend: {
      name: 'retail-smart-hub',
      framework: 'Vite + React + TypeScript',
      pages: 12,
    },
    backend: {
      framework: 'Express + TypeScript',
      status: 'phase-1-realized',
    },
  });
});

