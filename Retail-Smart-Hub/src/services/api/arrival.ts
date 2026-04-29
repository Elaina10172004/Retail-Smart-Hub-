import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import { type MaybePaginated, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  ArrivalDetailRecord,
  ArrivalRecord,
  CreateManualArrivalPayload,
  CreateManualArrivalResult,
  ManualArrivalCandidateItem,
} from '@/types/arrival';

export async function fetchArrivals() {
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<ArrivalRecord>>>('/arrival?pageSize=100');
  return unwrapPaginatedEnvelope(response);
}

export function fetchManualArrivalCreateOptions() {
  return apiClient.get<ApiEnvelope<ManualArrivalCandidateItem[]>>('/arrival/create-options');
}

export function createManualArrival(payload: CreateManualArrivalPayload) {
  return apiClient.post<ApiEnvelope<CreateManualArrivalResult>>('/arrival', payload);
}

export function fetchArrivalDetail(id: string) {
  return apiClient.get<ApiEnvelope<ArrivalDetailRecord>>(`/arrival/${id}`);
}

export function advanceArrival(id: string) {
  return apiClient.post<ApiEnvelope<ArrivalRecord>>(`/arrival/${id}/advance`);
}
