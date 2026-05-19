import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import { type MaybePaginated, pageQuery, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  CreateShipmentDocumentPayload,
  ShippingDetailRecord,
  ShippingRecord,
  ShippingWorkbenchCustomer,
} from '@/types/shipping';

export async function fetchShipments() {
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<ShippingRecord>>>('/shipping?pageSize=100');
  return unwrapPaginatedEnvelope(response);
}

export function fetchShipmentsPaginated(params?: { page?: number; pageSize?: number; search?: string; status?: string }) {
  return apiClient.get<ApiEnvelope<PaginatedData<ShippingRecord>>>(`/shipping${pageQuery(params)}`);
}

export function fetchShippingWorkbench() {
  return apiClient.get<ApiEnvelope<ShippingWorkbenchCustomer[]>>('/shipping/workbench');
}

export function fetchShipmentDetail(id: string) {
  return apiClient.get<ApiEnvelope<ShippingDetailRecord>>(`/shipping/${id}`);
}

export function createShipmentDocument(payload: CreateShipmentDocumentPayload) {
  return apiClient.post<ApiEnvelope<ShippingRecord>>('/shipping/documents', payload);
}

export function dispatchShipment(id: string) {
  return apiClient.post<ApiEnvelope<ShippingRecord>>(`/shipping/${id}/dispatch`);
}
