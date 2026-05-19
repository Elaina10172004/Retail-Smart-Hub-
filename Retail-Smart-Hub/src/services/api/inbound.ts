import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import { type MaybePaginated, type PageQueryParams, pageQuery, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  CreateManualInboundPayload,
  CreateManualInboundResult,
  DeleteInboundResponse,
  ForceUpdateInboundLinesPayload,
  InboundDetailRecord,
  InboundRecord,
  ManualInboundCandidateItem,
  SaveInboundDraftPayload,
  UpdateInboundStatusPayload,
} from '@/types/inbound';

export async function fetchInbounds() {
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<InboundRecord>>>('/inbound?pageSize=100');
  return unwrapPaginatedEnvelope(response);
}

export function fetchInboundsPaginated(params?: PageQueryParams) {
  return apiClient.get<ApiEnvelope<PaginatedData<InboundRecord>>>(`/inbound${pageQuery(params)}`);
}

export function fetchManualInboundCreateOptions() {
  return apiClient.get<ApiEnvelope<ManualInboundCandidateItem[]>>('/inbound/create-options');
}

export function createManualInbound(payload: CreateManualInboundPayload) {
  return apiClient.post<ApiEnvelope<CreateManualInboundResult>>('/inbound', payload);
}

export function fetchInboundDetail(id: string) {
  return apiClient.get<ApiEnvelope<InboundDetailRecord>>(`/inbound/${id}`);
}

export function saveInboundDraft(id: string, payload: SaveInboundDraftPayload) {
  return apiClient.post<ApiEnvelope<InboundDetailRecord>>(`/inbound/${id}/draft`, payload);
}

export function forceUpdateInboundLines(id: string, payload: ForceUpdateInboundLinesPayload) {
  return apiClient.post<ApiEnvelope<InboundDetailRecord>>(`/inbound/${id}/lines/force`, payload);
}

export function confirmInbound(id: string, payload?: SaveInboundDraftPayload) {
  return apiClient.post<ApiEnvelope<InboundRecord>>(`/inbound/${id}/confirm`, payload);
}

export function updateInboundStatus(id: string, payload: UpdateInboundStatusPayload) {
  return apiClient.post<ApiEnvelope<InboundRecord>>(`/inbound/${id}/status`, payload);
}

export function deleteInbound(id: string, options?: { aggressive?: boolean }) {
  const aggressive = options?.aggressive ? '?aggressive=1' : '';
  return apiClient.delete<ApiEnvelope<DeleteInboundResponse>>(`/inbound/${id}${aggressive}`);
}
