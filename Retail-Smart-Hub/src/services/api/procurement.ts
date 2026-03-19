import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  DeleteProcurementOrderResponse,
  GeneratedPurchaseOrder,
  ProcurementOrder,
  ProcurementOrderDetail,
  ProcurementSuggestionSummary,
  UpdateProcurementStatusPayload,
} from '@/types/procurement';

export function fetchProcurementOrders() {
  return apiClient.get<ApiEnvelope<ProcurementOrder[]>>('/procurement');
}

export function fetchProcurementOrderDetail(id: string) {
  return apiClient.get<ApiEnvelope<ProcurementOrderDetail>>(`/procurement/${id}`);
}

export function fetchProcurementSuggestions() {
  return apiClient.get<ApiEnvelope<ProcurementSuggestionSummary>>('/procurement/suggestions');
}

export function generateSuggestedPurchaseOrders() {
  return apiClient.post<ApiEnvelope<GeneratedPurchaseOrder[]>>('/procurement/generate-shortage-orders');
}

export function updateProcurementStatus(id: string, payload: UpdateProcurementStatusPayload) {
  return apiClient.post<ApiEnvelope<ProcurementOrderDetail | null>>(`/procurement/${id}/status`, payload);
}

export function deleteProcurementOrder(id: string, options?: { aggressive?: boolean }) {
  const aggressive = options?.aggressive ? '?aggressive=1' : '';
  return apiClient.delete<ApiEnvelope<DeleteProcurementOrderResponse>>(`/procurement/${id}${aggressive}`);
}
