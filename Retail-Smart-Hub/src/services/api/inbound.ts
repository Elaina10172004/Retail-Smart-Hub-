import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import { type MaybePaginated, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  CreateManualInboundPayload,
  CreateManualInboundResult,
  DeleteInboundResponse,
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
