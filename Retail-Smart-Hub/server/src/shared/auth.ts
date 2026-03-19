import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { appendAuditLog, db, ensureAccessControlData, ensureAuthSecurityData, nextDocumentId } from '../database/db';
import { clearRateLimit, consumeRateLimit } from './rate-limit';
import { generateTemporaryPassword, hashOpaqueToken, hashPassword, verifyPassword } from './password';
import { fail } from './response';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  phone: string;
  department: string;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
  token: string;
  sessionId: string;
}

export interface SessionPayload {
  token: string;
  sessionId: string;
  user: Omit<AuthenticatedUser, 'token' | 'sessionId'>;
}

export interface AuthSessionRecord {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
  ipAddress: string;
  isCurrent: boolean;
}

export interface PasswordSecuritySummary {
  passwordUpdatedAt: string | null;
  passwordAgeDays: number | null;
  rotationIntervalDays: number;
  rotationWarningDays: number;
  daysUntilRotation: number | null;
  shouldWarnRotation: boolean;
  needsRotation: boolean;
  mustChangePassword: boolean;
  usesDefaultPassword: boolean;
}

export interface UpdateProfilePayload {
  email: string;
  phone?: string;
  department: string;
}

export interface PasswordResetRequestPayload {
  username: string;
  email: string;
  phone?: string;
}

export interface PasswordResetConfirmPayload {
  resetToken: string;
  newPassword: string;
}

export type PasswordResetDeliveryMode = 'local-demo' | 'external-channel-required';

export interface PasswordResetRequestResult {
  accepted: boolean;
  expiresInMinutes: number;
  delivery: PasswordResetDeliveryMode;
  resetTokenPreview?: string;
}

export interface CreateSessionContext {
  ipAddress?: string;
  userAgent?: string;
}

interface SessionRow {
  sessionId: string;
  tokenHash: string;
  userId: string;
  username: string;
  email: string;
  phone: string | null;
  department: string;
  status: string;
  mustChangePassword: number;
  roles: string | null;
  permissions: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  userAgent: string | null;
  ipAddress: string | null;
}

interface UserAuthRow {
  userId: string;
  username: string;
  email: string;
  phone: string | null;
  department: string;
  status: string;
  password: string;
  mustChangePassword: number;
  passwordUpdatedAt: string | null;
  failedAttemptCount: number | null;
  lockedUntil: string | null;
}

interface UserCredentialRow {
  username: string;
  password: string;
  mustChangePassword: number;
  passwordUpdatedAt: string | null;
}

interface PasswordResetTokenRow {
  id: string;
  userId: string;
  expiresAt: string;
  usedAt: string | null;
}

let legacySessionTokenMigrated = false;

const PASSWORD_MIN_LENGTH = 8;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MINUTES = 15;
const PASSWORD_ROTATION_DAYS = 90;
const PASSWORD_ROTATION_WARNING_DAYS = 14;
const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

const LOGIN_RATE_LIMIT_CONFIG = {
  windowMs: 60_000,
  maxAttempts: 10,
  blockMs: 10 * 60_000,
};

const PASSWORD_RESET_REQUEST_RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60_000,
  maxAttempts: 6,
  blockMs: 30 * 60_000,
};

const PASSWORD_RESET_CONFIRM_RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60_000,
  maxAttempts: 8,
  blockMs: 30 * 60_000,
};

const PASSWORD_POLICY_MESSAGE = `密码至少 ${PASSWORD_MIN_LENGTH} 位，且需包含大写字母、小写字母、数字、特殊字符中的至少 3 类。`;

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}

function sessionExpiry(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function parseList(value: string | null) {
  return value ? value.split(',').filter(Boolean) : [];
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePassword(value: string) {
  return value.trim();
}

function countPasswordClasses(password: string) {
  let classes = 0;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[a-z]/.test(password)) classes += 1;
  if (/\d/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  return classes;
}

function lockUntilIso() {
  return new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000).toISOString();
}

function formatLockMessage(lockedUntil: string) {
  const lockedAt = new Date(lockedUntil);
  if (Number.isNaN(lockedAt.getTime())) {
    return `登录失败次数过多，账号已锁定 ${LOGIN_LOCK_MINUTES} 分钟。`;
  }

  return `登录失败次数过多，账号已锁定至 ${lockedAt.toLocaleString('zh-CN', { hour12: false })}。`;
}

function calculatePasswordAgeDays(passwordUpdatedAt: string | null) {
  if (!passwordUpdatedAt) {
    return null;
  }

  const updatedAt = new Date(passwordUpdatedAt).getTime();
  if (Number.isNaN(updatedAt)) {
    return null;
  }

  return Math.max(Math.floor((Date.now() - updatedAt) / (1000 * 60 * 60 * 24)), 0);
}

function shouldRefreshLastSeen(lastSeenAt: string | null, thresholdMs = 5 * 60 * 1000) {
  if (!lastSeenAt) {
    return true;
  }

  const lastSeenTimestamp = new Date(lastSeenAt).getTime();
  if (Number.isNaN(lastSeenTimestamp)) {
    return true;
  }

  return Date.now() - lastSeenTimestamp >= thresholdMs;
}

function extractToken(req: Request) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }

  const headerToken = req.headers['x-auth-token'];
  return typeof headerToken === 'string' ? headerToken : '';
}

function findSessionRowByStoredToken(storedToken: string) {
  return db.prepare<SessionRow>(`
    SELECT
      s.session_id as sessionId,
      s.token as tokenHash,
      u.id as userId,
      u.username,
      u.email,
      u.phone,
      u.department,
      u.status,
      COALESCE(c.must_change_password, 0) as mustChangePassword,
      s.created_at as createdAt,
      s.expires_at as expiresAt,
      s.last_seen_at as lastSeenAt,
      COALESCE(s.user_agent, '') as userAgent,
      COALESCE(s.ip_address, '') as ipAddress,
      GROUP_CONCAT(DISTINCT r.name) as roles,
      GROUP_CONCAT(DISTINCT p.code) as permissions
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_credentials c ON c.user_id = u.id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
    WHERE s.token = ?
      AND s.expires_at >= ?
    GROUP BY s.session_id, s.token, u.id, u.username, u.email, u.phone, u.department, u.status, c.must_change_password, s.created_at, s.expires_at, s.last_seen_at, s.user_agent, s.ip_address
  `).get(storedToken, nowIso());
}

function isSessionTokenHash(value: string) {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

function migrateLegacySessionTokensOnce() {
  if (legacySessionTokenMigrated) {
    return;
  }

  const rows = db.prepare<{ token: string }>('SELECT token FROM auth_sessions').all();
  const updateSessionToken = db.prepare('UPDATE auth_sessions SET token = ? WHERE token = ?');
  const deleteSessionToken = db.prepare('DELETE FROM auth_sessions WHERE token = ?');
  const findByToken = db.prepare<{ token: string }>('SELECT token FROM auth_sessions WHERE token = ?');

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const rawToken = row.token;
      if (!rawToken || isSessionTokenHash(rawToken)) {
        continue;
      }

      const tokenHash = hashOpaqueToken(rawToken);
      const existing = findByToken.get(tokenHash);
      if (existing) {
        deleteSessionToken.run(rawToken);
        continue;
      }

      updateSessionToken.run(tokenHash, rawToken);
    }
  });

  transaction();
  legacySessionTokenMigrated = true;
}

function migrateLegacySessionToken(rawToken: string, tokenHash: string) {
  const existing = db.prepare<{ token: string }>('SELECT token FROM auth_sessions WHERE token = ?').get(tokenHash);
  if (existing) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(rawToken);
    return;
  }
  db.prepare('UPDATE auth_sessions SET token = ? WHERE token = ?').run(tokenHash, rawToken);
}

function findSessionRow(token: string) {
  migrateLegacySessionTokensOnce();
  const tokenHash = hashOpaqueToken(token);
  const hashed = findSessionRowByStoredToken(tokenHash);
  if (hashed) {
    return hashed;
  }

  // Backward compatibility: legacy rows may still store plaintext session token.
  const legacy = findSessionRowByStoredToken(token);
  if (!legacy) {
    return null;
  }

  migrateLegacySessionToken(token, tokenHash);
  return findSessionRowByStoredToken(tokenHash);
}

function findUserAuthRow(username: string) {
  return db.prepare<UserAuthRow>(`
    SELECT
      u.id as userId,
      u.username,
      u.email,
      u.phone,
      u.department,
      u.status,
      c.password,
      COALESCE(c.must_change_password, 0) as mustChangePassword,
      c.password_updated_at as passwordUpdatedAt,
      ass.failed_attempt_count as failedAttemptCount,
      ass.locked_until as lockedUntil
    FROM users u
    JOIN user_credentials c ON c.user_id = u.id
    LEFT JOIN auth_security_state ass ON ass.user_id = u.id
    WHERE u.username = ?
  `).get(username);
}

function findUserCredentialRow(userId: string) {
  return db.prepare<UserCredentialRow>(`
    SELECT
      u.username,
      c.password,
      COALESCE(c.must_change_password, 0) as mustChangePassword,
      c.password_updated_at as passwordUpdatedAt
    FROM user_credentials c
    JOIN users u ON u.id = c.user_id
    WHERE c.user_id = ?
  `).get(userId);
}

function toSessionPayload(row: SessionRow, rawToken: string): SessionPayload {
  return {
    token: rawToken,
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      username: row.username,
      email: row.email,
      phone: row.phone ?? '',
      department: row.department,
      status: row.status,
      mustChangePassword: Boolean(row.mustChangePassword),
      roles: parseList(row.roles),
      permissions: parseList(row.permissions),
    },
  };
}

function resetSecurityState(userId: string, passwordUpdatedAt?: string) {
  db.prepare(
    `UPDATE auth_security_state
      SET failed_attempt_count = 0,
          last_failed_at = NULL,
          locked_until = NULL,
          password_updated_at = COALESCE(?, password_updated_at)
      WHERE user_id = ?`
  ).run(passwordUpdatedAt || null, userId);
}

function recordLoginAttempt(username: string, userId: string | null, success: boolean, reason: string, context: CreateSessionContext) {
  db.prepare(
    `INSERT INTO auth_login_attempts (
      username, user_id, success, failure_reason, ip_address, user_agent, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    username,
    userId,
    success ? 1 : 0,
    reason,
    context.ipAddress?.trim() || null,
    context.userAgent?.trim() || null,
    nowIso(),
  );
}

function revokeUserSessions(userId: string, exceptToken?: string) {
  if (exceptToken) {
    const exceptTokenHash = hashOpaqueToken(exceptToken);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token <> ?').run(userId, exceptTokenHash);
    return;
  }

  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

function enforceRateLimit(namespace: string, key: string, config: { windowMs: number; maxAttempts: number; blockMs: number }, message: string) {
  const result = consumeRateLimit(`${namespace}:${key}`, config);
  if (!result.allowed) {
    throw new Error(`${message}（请在 ${result.retryAfterSeconds} 秒后重试）`);
  }
}

function registerFailedLogin(user: UserAuthRow | null, context: CreateSessionContext, username: string) {
  if (!user) {
    recordLoginAttempt(username, null, false, 'invalid_username', context);
    throw new Error('用户名或密码错误');
  }

  const attemptedAt = nowIso();
  const nextFailedCount = (user.failedAttemptCount ?? 0) + 1;
  const nextLockedUntil = nextFailedCount >= LOGIN_FAILURE_LIMIT ? lockUntilIso() : null;

  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE auth_security_state
        SET failed_attempt_count = ?,
            last_failed_at = ?,
            locked_until = ?
        WHERE user_id = ?`
    ).run(nextFailedCount, attemptedAt, nextLockedUntil, user.userId);

    recordLoginAttempt(username, user.userId, false, nextLockedUntil ? 'locked' : 'invalid_password', context);
  });

  transaction();

  if (nextLockedUntil) {
    throw new Error(formatLockMessage(nextLockedUntil));
  }

  throw new Error('用户名或密码错误');
}

function upsertCredentialPassword(userId: string, passwordHash: string, options?: { mustChangePassword?: boolean; temporaryIssuedAt?: string | null }) {
  const updatedAt = nowIso();
  db.prepare(
    `UPDATE user_credentials
      SET password = ?,
          password_updated_at = ?,
          must_change_password = ?,
          temporary_password_issued_at = ?
      WHERE user_id = ?`
  ).run(
    passwordHash,
    updatedAt,
    options?.mustChangePassword ? 1 : 0,
    options?.temporaryIssuedAt ?? null,
    userId,
  );

  resetSecurityState(userId, updatedAt);
}

function cleanupExpiredResetTokens() {
  db.prepare('DELETE FROM auth_password_reset_tokens WHERE expires_at < ?').run(nowIso());
}

function allowWhenPasswordChangeRequired(req: Request) {
  const allowedPrefixes = [
    '/api/system/session',
    '/api/system/sessions',
    '/api/system/change-password',
    '/api/system/logout',
    '/api/system/modules',
    '/api/system/notifications',
  ];

  return allowedPrefixes.some((prefix) => req.originalUrl.startsWith(prefix));
}

export function assertStrongPassword(password: string, username?: string) {
  const normalized = normalizePassword(password);
  if (normalized.length < PASSWORD_MIN_LENGTH) {
    throw new Error(PASSWORD_POLICY_MESSAGE);
  }

  if (countPasswordClasses(normalized) < 3) {
    throw new Error(PASSWORD_POLICY_MESSAGE);
  }

  if (username && normalized.toLowerCase().includes(username.toLowerCase())) {
    throw new Error('新密码不能包含用户名。');
  }

  return normalized;
}

export function getPasswordPolicySummary() {
  return {
    minLength: PASSWORD_MIN_LENGTH,
    requiredClassCount: 3,
    failureLimit: LOGIN_FAILURE_LIMIT,
    lockMinutes: LOGIN_LOCK_MINUTES,
    rotationIntervalDays: PASSWORD_ROTATION_DAYS,
    rotationWarningDays: PASSWORD_ROTATION_WARNING_DAYS,
    firstLoginMustChangePassword: true,
    message: PASSWORD_POLICY_MESSAGE,
  };
}

export function getPasswordSecuritySummary(userId: string): PasswordSecuritySummary {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const credential = findUserCredentialRow(userId);
  if (!credential) {
    return {
      passwordUpdatedAt: null,
      passwordAgeDays: null,
      rotationIntervalDays: PASSWORD_ROTATION_DAYS,
      rotationWarningDays: PASSWORD_ROTATION_WARNING_DAYS,
      daysUntilRotation: null,
      shouldWarnRotation: false,
      needsRotation: false,
      mustChangePassword: false,
      usesDefaultPassword: false,
    };
  }

  const passwordAgeDays = calculatePasswordAgeDays(credential.passwordUpdatedAt);
  const daysUntilRotation = passwordAgeDays === null ? null : PASSWORD_ROTATION_DAYS - passwordAgeDays;
  const mustChangePassword = Boolean(credential.mustChangePassword);
  const needsRotation = mustChangePassword || (daysUntilRotation !== null && daysUntilRotation <= 0);
  const shouldWarnRotation = !needsRotation && daysUntilRotation !== null && daysUntilRotation <= PASSWORD_ROTATION_WARNING_DAYS;

  return {
    passwordUpdatedAt: credential.passwordUpdatedAt,
    passwordAgeDays,
    rotationIntervalDays: PASSWORD_ROTATION_DAYS,
    rotationWarningDays: PASSWORD_ROTATION_WARNING_DAYS,
    daysUntilRotation,
    shouldWarnRotation,
    needsRotation,
    mustChangePassword,
    usesDefaultPassword: false,
  };
}

export function createSession(username: string, password: string, context: CreateSessionContext = {}) {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const normalizedUsername = username.trim();
  const normalizedPassword = normalizePassword(password);
  const loginLimiterKey = `${context.ipAddress || 'unknown'}:${normalizedUsername}`;
  enforceRateLimit('login', loginLimiterKey, LOGIN_RATE_LIMIT_CONFIG, '登录尝试过于频繁');

  const user = findUserAuthRow(normalizedUsername);

  if (!user) {
    registerFailedLogin(null, context, normalizedUsername);
  }

  if (!user) {
    throw new Error('用户名或密码错误');
  }

  if (user.status !== 'active') {
    recordLoginAttempt(normalizedUsername, user.userId, false, 'inactive_user', context);
    throw new Error('当前账号已停用');
  }

  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    recordLoginAttempt(normalizedUsername, user.userId, false, 'locked', context);
    throw new Error(formatLockMessage(user.lockedUntil));
  }

  const verification = verifyPassword(normalizedPassword, user.password);
  if (!verification.matched) {
    registerFailedLogin(user, context, normalizedUsername);
  }

  const sessionId = 'SES-' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  const rawToken = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashOpaqueToken(rawToken);
  const now = nowIso();

  const transaction = db.transaction(() => {
    if (verification.needsUpgrade) {
      db.prepare('UPDATE user_credentials SET password = ?, password_updated_at = ? WHERE user_id = ?').run(
        hashPassword(normalizedPassword),
        now,
        user.userId,
      );
    }

    resetSecurityState(user.userId);
    recordLoginAttempt(normalizedUsername, user.userId, true, 'success', context);
    db.prepare(
      'INSERT INTO auth_sessions (session_id, token, user_id, created_at, expires_at, last_seen_at, user_agent, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      sessionId,
      tokenHash,
      user.userId,
      now,
      sessionExpiry(),
      now,
      context.userAgent?.trim() || null,
      context.ipAddress?.trim() || null,
    );
  });

  transaction();
  clearRateLimit(`login:${loginLimiterKey}`);

  const session = findSessionRow(rawToken);
  if (!session) {
    throw new Error('会话创建失败');
  }

  return toSessionPayload(session, rawToken);
}

export function getSession(token: string) {
  ensureAccessControlData();
  ensureAuthSecurityData();
  if (!token) {
    return null;
  }

  const session = findSessionRow(token);
  if (!session) {
    return null;
  }

  if (shouldRefreshLastSeen(session.lastSeenAt)) {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token = ?').run(nowIso(), session.tokenHash);
  }
  return toSessionPayload(session, token);
}

export function listUserSessions(userId: string, currentToken: string) {
  ensureAccessControlData();
  ensureAuthSecurityData();
  migrateLegacySessionTokensOnce();
  const currentTokenHash = currentToken ? hashOpaqueToken(currentToken) : '';

  return db.prepare<SessionRow>(`
    SELECT
      s.session_id as sessionId,
      s.token as tokenHash,
      u.id as userId,
      u.username,
      u.email,
      u.phone,
      u.department,
      u.status,
      COALESCE(c.must_change_password, 0) as mustChangePassword,
      s.created_at as createdAt,
      s.expires_at as expiresAt,
      s.last_seen_at as lastSeenAt,
      COALESCE(s.user_agent, '') as userAgent,
      COALESCE(s.ip_address, '') as ipAddress,
      GROUP_CONCAT(DISTINCT r.name) as roles,
      GROUP_CONCAT(DISTINCT p.code) as permissions
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_credentials c ON c.user_id = u.id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
    WHERE s.user_id = ?
      AND s.expires_at >= ?
    GROUP BY s.session_id, s.token, u.id, u.username, u.email, u.phone, u.department, u.status, c.must_change_password, s.created_at, s.expires_at, s.last_seen_at, s.user_agent, s.ip_address
    ORDER BY CASE WHEN s.token = ? THEN 0 ELSE 1 END ASC, s.last_seen_at DESC, s.created_at DESC
  `).all(userId, nowIso(), currentTokenHash).map((row) => ({
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt || row.createdAt,
    userAgent: row.userAgent || '未知终端',
    ipAddress: row.ipAddress || '-',
    isCurrent: row.tokenHash === currentTokenHash,
  }));
}

export function revokeSession(token: string, actorUserId?: string) {
  if (!token) {
    return;
  }
  migrateLegacySessionTokensOnce();
  const tokenHash = hashOpaqueToken(token);
  const legacyToken = token;

  if (actorUserId) {
    const session =
      db.prepare<{ userId: string }>('SELECT user_id as userId FROM auth_sessions WHERE token = ?').get(tokenHash) ||
      db.prepare<{ userId: string }>('SELECT user_id as userId FROM auth_sessions WHERE token = ?').get(legacyToken);
    if (!session || session.userId !== actorUserId) {
      throw new Error('Session not found');
    }
  }

  const result = db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(tokenHash);
  if (result.changes === 0) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(legacyToken);
  }
}

export function revokeSessionById(sessionId: string, actorUserId?: string) {
  if (!sessionId) {
    return;
  }
  migrateLegacySessionTokensOnce();

  if (actorUserId) {
    const session = db.prepare<{ userId: string }>('SELECT user_id as userId FROM auth_sessions WHERE session_id = ?').get(sessionId);
    if (!session || session.userId !== actorUserId) {
      throw new Error('Session not found');
    }
  }

  db.prepare('DELETE FROM auth_sessions WHERE session_id = ?').run(sessionId);
}
export function revokeOtherSessions(userId: string, currentToken: string) {
  migrateLegacySessionTokensOnce();
  const currentTokenHash = hashOpaqueToken(currentToken);
  const count = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM auth_sessions WHERE user_id = ? AND token <> ?').get(userId, currentTokenHash)?.count ?? 0;
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token <> ?').run(userId, currentTokenHash);

  appendAuditLog('revoke_other_sessions', 'user', userId, {
    revokedSessionCount: count,
  });

  return count;
}

export function verifyCurrentPassword(userId: string, currentPassword: string) {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const normalizedCurrentPassword = normalizePassword(currentPassword);
  if (!normalizedCurrentPassword) {
    throw new Error('Current password is required');
  }

  const credential = findUserCredentialRow(userId);
  if (!credential) {
    throw new Error('Credential not found');
  }

  const result = verifyPassword(normalizedCurrentPassword, credential.password);
  if (!result.matched) {
    throw new Error('二次验证失败：当前登录密码不正确。');
  }

  return credential;
}

export function changePassword(userId: string, currentPassword: string, nextPassword: string, currentToken?: string) {
  ensureAccessControlData();
  ensureAuthSecurityData();
  const normalizedCurrentPassword = normalizePassword(currentPassword);
  const credential = verifyCurrentPassword(userId, currentPassword);

  const normalizedNextPassword = assertStrongPassword(nextPassword, credential.username);
  if (normalizedCurrentPassword === normalizedNextPassword) {
    throw new Error('新密码不能与当前密码相同。');
  }

  upsertCredentialPassword(userId, hashPassword(normalizedNextPassword), {
    mustChangePassword: false,
    temporaryIssuedAt: null,
  });
  revokeUserSessions(userId, currentToken);

  appendAuditLog('change_password', 'user', userId, {
    by: userId,
  });
}

export function updateProfile(userId: string, payload: UpdateProfilePayload) {
  ensureAccessControlData();

  const email = payload.email.trim();
  const department = payload.department.trim();
  const phone = payload.phone?.trim() || null;

  if (!email) {
    throw new Error('Email is required');
  }

  if (!department) {
    throw new Error('Department is required');
  }

  const user = db.prepare<{ id: string }>('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const duplicate = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM users WHERE email = ? AND id <> ?'
  ).get(email, userId)?.count ?? 0;

  if (duplicate > 0) {
    throw new Error('Email already exists');
  }

  db.prepare('UPDATE users SET email = ?, phone = ?, department = ? WHERE id = ?').run(email, phone, department, userId);

  appendAuditLog('update_profile', 'user', userId, {
    email,
    phone,
    department,
  });
}

export function resetUserPassword(targetUserId: string, nextPassword: string, actorUserId: string) {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const user = db.prepare<{ username: string }>('SELECT username FROM users WHERE id = ?').get(targetUserId);
  if (!user) {
    throw new Error('Credential not found');
  }

  const normalizedNextPassword = assertStrongPassword(nextPassword, user.username);
  upsertCredentialPassword(targetUserId, hashPassword(normalizedNextPassword), {
    mustChangePassword: true,
    temporaryIssuedAt: nowIso(),
  });
  revokeUserSessions(targetUserId);

  appendAuditLog('reset_user_password', 'user', targetUserId, {
    by: actorUserId,
  });
}

export function issueTemporaryPasswordForUser(targetUserId: string, actorUserId: string) {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const user = db.prepare<{ username: string }>('SELECT username FROM users WHERE id = ?').get(targetUserId);
  if (!user) {
    throw new Error('Credential not found');
  }

  const temporaryPassword = generateTemporaryPassword(18);
  upsertCredentialPassword(targetUserId, hashPassword(temporaryPassword), {
    mustChangePassword: true,
    temporaryIssuedAt: nowIso(),
  });
  revokeUserSessions(targetUserId);

  appendAuditLog('issue_temporary_password', 'user', targetUserId, {
    by: actorUserId,
  });

  return temporaryPassword;
}

export function requestPasswordReset(payload: PasswordResetRequestPayload, context: CreateSessionContext = {}): PasswordResetRequestResult {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const username = payload.username.trim();
  const email = payload.email.trim();
  const phone = payload.phone?.trim() || '';
  const limiterKey = `${context.ipAddress || 'unknown'}:${username}:${email}`;
  enforceRateLimit('password-reset-request', limiterKey, PASSWORD_RESET_REQUEST_RATE_LIMIT_CONFIG, '找回密码请求过于频繁');

  cleanupExpiredResetTokens();

  const user = db.prepare<{ userId: string; phone: string | null; status: string }>(`
    SELECT id as userId, phone, status
    FROM users
    WHERE username = ?
      AND email = ?
  `).get(username, email);

  let tokenPreview: string | undefined;
  let delivery: PasswordResetDeliveryMode = 'external-channel-required';

  if (user && user.status === 'active' && (user.phone ?? '') === phone) {
    const rawToken = crypto.randomBytes(24).toString('base64url');
    const tokenHash = hashOpaqueToken(rawToken);
    const requestedAt = nowIso();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();
    const tokenId = nextDocumentId('auth_password_reset_tokens', 'RST');

    const transaction = db.transaction(() => {
      db.prepare('UPDATE auth_password_reset_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND used_at IS NULL').run(requestedAt, user.userId);
      db.prepare(
        `INSERT INTO auth_password_reset_tokens (
          id, user_id, token_hash, requested_at, expires_at, used_at,
          request_ip, request_user_agent, consumed_ip, consumed_user_agent
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`
      ).run(
        tokenId,
        user.userId,
        tokenHash,
        requestedAt,
        expiresAt,
        context.ipAddress?.trim() || null,
        context.userAgent?.trim() || null,
      );

      appendAuditLog('request_password_reset', 'user', user.userId, {
        channel: env.authDebugExposeResetToken ? 'local-demo' : 'external-channel-required',
        expiresAt,
      });
    });

    transaction();

    if (env.authDebugExposeResetToken) {
      tokenPreview = rawToken;
      delivery = 'local-demo';
    }
  } else {
    appendAuditLog('request_password_reset_rejected', 'auth', `RESET-${hashOpaqueToken(`${username}|${email}`).slice(0, 16)}`, {
      username,
      email,
      reason: 'identity_mismatch_or_inactive',
      ipAddress: context.ipAddress?.trim() || null,
    });
  }

  return {
    accepted: true,
    expiresInMinutes: Math.floor(PASSWORD_RESET_TOKEN_TTL_MS / 60_000),
    delivery,
    resetTokenPreview: tokenPreview,
  };
}

export function confirmPasswordReset(payload: PasswordResetConfirmPayload, context: CreateSessionContext = {}) {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const token = payload.resetToken.trim();
  if (!token) {
    throw new Error('resetToken is required');
  }

  const confirmLimiterKey = `${context.ipAddress || 'unknown'}:${hashOpaqueToken(token)}`;
  enforceRateLimit('password-reset-confirm', confirmLimiterKey, PASSWORD_RESET_CONFIRM_RATE_LIMIT_CONFIG, '重置密码尝试过于频繁');

  const tokenHash = hashOpaqueToken(token);
  const tokenRow = db.prepare<PasswordResetTokenRow>(`
    SELECT id, user_id as userId, expires_at as expiresAt, used_at as usedAt
    FROM auth_password_reset_tokens
    WHERE token_hash = ?
  `).get(tokenHash);

  if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt < nowIso()) {
    appendAuditLog('confirm_password_reset_rejected', 'auth', `RESET-${tokenHash.slice(0, 16)}`, {
      reason: 'invalid_or_expired_token',
      ipAddress: context.ipAddress?.trim() || null,
    });
    throw new Error('重置令牌无效或已过期');
  }

  const user = db.prepare<{ username: string }>('SELECT username FROM users WHERE id = ? AND status = ?').get(tokenRow.userId, 'active');
  if (!user) {
    appendAuditLog('confirm_password_reset_rejected', 'auth', tokenRow.id, {
      reason: 'user_inactive_or_missing',
      ipAddress: context.ipAddress?.trim() || null,
    });
    throw new Error('重置令牌无效或已过期');
  }

  const normalizedNextPassword = assertStrongPassword(payload.newPassword, user.username);
  const consumedAt = nowIso();

  const transaction = db.transaction(() => {
    const consumeResult = db.prepare(
      `UPDATE auth_password_reset_tokens
        SET used_at = ?, consumed_ip = ?, consumed_user_agent = ?
        WHERE id = ? AND used_at IS NULL`
    ).run(
      consumedAt,
      context.ipAddress?.trim() || null,
      context.userAgent?.trim() || null,
      tokenRow.id,
    );

    if (consumeResult.changes === 0) {
      throw new Error('重置令牌无效或已过期');
    }

    upsertCredentialPassword(tokenRow.userId, hashPassword(normalizedNextPassword), {
      mustChangePassword: false,
      temporaryIssuedAt: null,
    });

    revokeUserSessions(tokenRow.userId);

    appendAuditLog('confirm_password_reset', 'user', tokenRow.userId, {
      tokenId: tokenRow.id,
    });
  });

  transaction();
  clearRateLimit(`password-reset-confirm:${confirmLimiterKey}`);
}

export function recoverPassword() {
  throw new Error('recover-password endpoint has been replaced, please call /api/system/recover-password/request then /confirm');
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  const session = getSession(token);

  if (!session) {
    return fail(res, 401, 'Authentication required');
  }

  req.auth = {
    ...session.user,
    token: session.token,
    sessionId: session.sessionId,
  };

  if (session.user.mustChangePassword && !allowWhenPasswordChangeRequired(req)) {
    return fail(res, 403, '首次登录需先修改密码。');
  }

  next();
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return fail(res, 401, 'Authentication required');
    }

    const isSuperAdmin =
      req.auth.username === 'admin' || req.auth.roles.includes('系统管理员');
    if (isSuperAdmin) {
      return next();
    }

    if (!req.auth.permissions.includes(permission)) {
      return fail(res, 403, `Missing permission: ${permission}`);
    }

    next();
  };
}












