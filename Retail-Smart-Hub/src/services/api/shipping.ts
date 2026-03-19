import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type { ShippingDetailRecord, ShippingRecord } from '@/types/shipping';

export function fetchShipments() {
  return apiClient.get<ApiEnvelope<ShippingRecord[]>>('/shipping');
}

export function fetchShipmentDetail(id: string) {
  return apiClient.get<ApiEnvelope<ShippingDetailRecord>>(`/shipping/${id}`);
}

export function dispatchShipment(id: string) {
  return apiClient.post<ApiEnvelope<ShippingRecord>>(`/shipping/${id}/dispatch`);
}
