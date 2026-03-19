import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  DeleteInboundResponse,
  InboundDetailRecord,
  InboundRecord,
  UpdateInboundStatusPayload,
} from '@/types/inbound';

export function fetchInbounds() {
  return apiClient.get<ApiEnvelope<InboundRecord[]>>('/inbound');
}

export function fetchInboundDetail(id: string) {
  return apiClient.get<ApiEnvelope<InboundDetailRecord>>(`/inbound/${id}`);
}

export function confirmInbound(id: string) {
  return apiClient.post<ApiEnvelope<InboundRecord>>(`/inbound/${id}/confirm`);
}

export function updateInboundStatus(id: string, payload: UpdateInboundStatusPayload) {
  return apiClient.post<ApiEnvelope<InboundRecord>>(`/inbound/${id}/status`, payload);
}

export function deleteInbound(id: string, options?: { aggressive?: boolean }) {
  const aggressive = options?.aggressive ? '?aggressive=1' : '';
  return apiClient.delete<ApiEnvelope<DeleteInboundResponse>>(`/inbound/${id}${aggressive}`);
}
