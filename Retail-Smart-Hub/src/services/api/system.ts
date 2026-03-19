import { apiClient } from '@/services/api/client';
import type {
  SessionPayload,
  LoginPayload,
  AuditLogRecord,
  ChangePasswordPayload,
  SessionManagementPayload,
  PasswordResetConfirmPayload,
  PasswordResetRequestPayload,
  SystemNotificationRecord,
  UpdateProfilePayload,
} from '@/types/auth';
import type { ApiEnvelope, HealthStatus, ModuleCatalogItem } from '@/types/api';

export function fetchHealthStatus() {
  return apiClient.get<ApiEnvelope<HealthStatus>>('/health');
}

export function login(payload: LoginPayload) {
  return apiClient.post<ApiEnvelope<SessionPayload>>('/system/login', payload);
}

export function fetchSession() {
  return apiClient.get<ApiEnvelope<SessionPayload>>('/system/session');
}

export function fetchSessionManagement() {
  return apiClient.get<ApiEnvelope<SessionManagementPayload>>('/system/sessions');
}

export function logout() {
  return apiClient.post<ApiEnvelope<boolean>>('/system/logout');
}

export function revokeOtherSessions(verifyPassword: string) {
  return apiClient.post<ApiEnvelope<{ revokedCount: number }>>('/system/sessions/revoke-others', { verifyPassword });
}

export function revokeManagedSession(sessionId: string, verifyPassword: string) {
  return apiClient.post<ApiEnvelope<boolean>>(`/system/sessions/${encodeURIComponent(sessionId)}/revoke`, { verifyPassword });
}

export function changePassword(payload: ChangePasswordPayload) {
  return apiClient.post<ApiEnvelope<boolean>>('/system/change-password', payload);
}

export function updateProfile(payload: UpdateProfilePayload) {
  return apiClient.post<ApiEnvelope<boolean>>('/system/profile', payload);
}

export function requestRecoverPassword(payload: PasswordResetRequestPayload) {
  return apiClient.post<ApiEnvelope<{ accepted: boolean; expiresInMinutes: number; delivery: 'local-demo' | 'external-channel-required'; resetTokenPreview?: string }>>(
    '/system/recover-password/request',
    payload
  );
}

export function confirmRecoverPassword(payload: PasswordResetConfirmPayload) {
  return apiClient.post<ApiEnvelope<boolean>>('/system/recover-password/confirm', payload);
}

export function fetchModuleCatalog() {
  return apiClient.get<ApiEnvelope<ModuleCatalogItem[]>>('/system/modules');
}

export function fetchAuditLogs(params?: { limit?: number; entityType?: string; action?: string }) {
  const search = new URLSearchParams();
  if (params?.limit) {
    search.set('limit', String(params.limit));
  }
  if (params?.entityType) {
    search.set('entityType', params.entityType);
  }
  if (params?.action) {
    search.set('action', params.action);
  }

  const suffix = search.toString() ? `?${search.toString()}` : '';
  return apiClient.get<ApiEnvelope<AuditLogRecord[]>>(`/system/audit-logs${suffix}`);
}

export function fetchNotifications(params?: { limit?: number }) {
  const search = new URLSearchParams();
  if (params?.limit) {
    search.set('limit', String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : '';
  return apiClient.get<ApiEnvelope<SystemNotificationRecord[]>>(`/system/notifications${suffix}`);
}
