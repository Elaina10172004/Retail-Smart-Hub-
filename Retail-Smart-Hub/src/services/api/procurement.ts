import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import type {
  CreateProcurementOrderPayload,
  DeleteProcurementOrderResponse,
  GeneratedPurchaseOrder,
  ProcurementArrivalWorkspaceRecord,
  ProcurementFormOptions,
  ProcurementOrder,
  ProcurementOrderDetail,
  ProcurementSuggestionSummary,
  RegisterProcurementArrivalPayload,
  UpdateProcurementStatusPayload,
} from '@/types/procurement';

export function fetchProcurementOrders(params?: { page?: number; pageSize?: number; search?: string }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params?.search) qs.set('search', params.search);
  const query = qs.toString();
  return apiClient.get<ApiEnvelope<PaginatedData<ProcurementOrder>>>(`/procurement${query ? `?${query}` : ''}`);
}

export function fetchProcurementOrderDetail(id: string) {
  return apiClient.get<ApiEnvelope<ProcurementOrderDetail>>(`/procurement/${id}`);
}

export function fetchProcurementArrivalWorkspace(id: string) {
  return apiClient.get<ApiEnvelope<ProcurementArrivalWorkspaceRecord>>(`/procurement/${id}/arrival-workspace`);
}

export function fetchProcurementSuggestions() {
  return apiClient.get<ApiEnvelope<ProcurementSuggestionSummary>>('/procurement/suggestions');
}

export function fetchProcurementFormOptions() {
  return apiClient.get<ApiEnvelope<ProcurementFormOptions>>('/procurement/form-options');
}

export function generateSuggestedPurchaseOrders() {
  return apiClient.post<ApiEnvelope<GeneratedPurchaseOrder[]>>('/procurement/generate-shortage-orders');
}

export function createProcurementOrder(payload: CreateProcurementOrderPayload) {
  return apiClient.post<ApiEnvelope<ProcurementOrderDetail>>('/procurement', payload);
}

export function registerProcurementArrival(id: string, payload: RegisterProcurementArrivalPayload) {
  return apiClient.post<ApiEnvelope<ProcurementArrivalWorkspaceRecord>>(`/procurement/${id}/arrival`, payload);
}

export function updateProcurementStatus(id: string, payload: UpdateProcurementStatusPayload) {
  return apiClient.post<ApiEnvelope<ProcurementOrderDetail | null>>(`/procurement/${id}/status`, payload);
}

export function deleteProcurementOrder(id: string, options?: { aggressive?: boolean }) {
  const aggressive = options?.aggressive ? '?aggressive=1' : '';
  return apiClient.delete<ApiEnvelope<DeleteProcurementOrderResponse>>(`/procurement/${id}${aggressive}`);
}
