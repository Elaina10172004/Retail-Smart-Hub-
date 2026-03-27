import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  CreateShipmentDocumentPayload,
  ShippingDetailRecord,
  ShippingRecord,
  ShippingWorkbenchCustomer,
} from '@/types/shipping';

export function fetchShipments() {
  return apiClient.get<ApiEnvelope<ShippingRecord[]>>('/shipping');
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
