import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  InventoryAdjustmentPayload,
  InventoryAlert,
  DeleteInventoryResponse,
  InventoryDetailRecord,
  InventoryItem,
  InventoryOverview,
} from '@/types/inventory';

export function fetchInventoryList() {
  return apiClient.get<ApiEnvelope<InventoryItem[]>>('/inventory');
}

export function fetchInventoryDetail(sku: string) {
  return apiClient.get<ApiEnvelope<InventoryDetailRecord>>(`/inventory/${encodeURIComponent(sku)}`);
}

export function fetchInventoryAlerts() {
  return apiClient.get<ApiEnvelope<InventoryAlert[]>>('/inventory/alerts');
}

export function fetchInventoryOverview() {
  return apiClient.get<ApiEnvelope<InventoryOverview>>('/inventory/overview');
}

export function adjustInventory(payload: InventoryAdjustmentPayload) {
  return apiClient.post<ApiEnvelope<InventoryItem>>('/inventory/adjust', payload);
}

export function deleteInventory(sku: string, options?: { aggressive?: boolean }) {
  const aggressive = options?.aggressive ? '?aggressive=1' : '';
  return apiClient.delete<ApiEnvelope<DeleteInventoryResponse>>(`/inventory/${encodeURIComponent(sku)}${aggressive}`);
}
