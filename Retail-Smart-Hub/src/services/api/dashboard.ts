import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type { DashboardOverview } from '@/types/dashboard';

export function fetchDashboardOverview() {
  return apiClient.get<ApiEnvelope<DashboardOverview>>('/dashboard/overview');
}
