export interface SessionUser {
  id: string;
  username: string;
  email: string;
  phone: string;
  department: string;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface SessionPayload {
  token: string;
  sessionId: string;
  user: SessionUser;
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

export interface PasswordPolicySummary {
  minLength: number;
  requiredClassCount: number;
  failureLimit: number;
  lockMinutes: number;
  rotationIntervalDays: number;
  rotationWarningDays: number;
  firstLoginMustChangePassword: boolean;
  message: string;
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

export interface SessionManagementPayload {
  sessions: AuthSessionRecord[];
  policy: PasswordPolicySummary;
  security: PasswordSecuritySummary;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
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

export interface AuditLogRecord {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  payload: string;
  createdAt: string;
}

export type SystemNotificationLevel = 'critical' | 'warning' | 'info' | 'success';

export interface SystemNotificationRecord {
  id: string;
  title: string;
  description: string;
  moduleId: string;
  level: SystemNotificationLevel;
  createdAt: string;
  requiredPermissions?: string[];
}
