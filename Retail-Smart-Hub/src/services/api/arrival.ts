import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import { type MaybePaginated, type PageQueryParams, pageQuery, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  ArrivalDetailRecord,
  ArrivalRecord,
  CreateManualArrivalPayload,
  CreateManualArrivalResult,
  ForceUpdateArrivalLinesPayload,
  ManualArrivalCandidateItem,
} from '@/types/arrival';

export async function fetchArrivals() {
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<ArrivalRecord>>>('/arrival?pageSize=100');
  return unwrapPaginatedEnvelope(response);
}

export function fetchArrivalsPaginated(params?: PageQueryParams) {
  return apiClient.get<ApiEnvelope<PaginatedData<ArrivalRecord>>>(`/arrival${pageQuery(params)}`);
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

export function forceUpdateArrivalLines(id: string, payload: ForceUpdateArrivalLinesPayload) {
  return apiClient.post<ApiEnvelope<ArrivalDetailRecord>>(`/arrival/${id}/lines/force`, payload);
}
