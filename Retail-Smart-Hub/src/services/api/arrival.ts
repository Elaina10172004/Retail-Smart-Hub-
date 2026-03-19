import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type { ArrivalDetailRecord, ArrivalRecord } from '@/types/arrival';

export function fetchArrivals() {
  return apiClient.get<ApiEnvelope<ArrivalRecord[]>>('/arrival');
}

export function fetchArrivalDetail(id: string) {
  return apiClient.get<ApiEnvelope<ArrivalDetailRecord>>(`/arrival/${id}`);
}

export function advanceArrival(id: string) {
  return apiClient.post<ApiEnvelope<ArrivalRecord>>(`/arrival/${id}/advance`);
}
