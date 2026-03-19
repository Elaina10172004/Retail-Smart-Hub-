import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type { ReportOverview } from '@/types/reports';

export function fetchReportOverview() {
  return apiClient.get<ApiEnvelope<ReportOverview>>('/reports/overview');
}
