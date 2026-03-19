import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  CreateOrderPayload,
  DeleteOrderResponse,
  OrderDetailRecord,
  OrderRecord,
  UpdateOrderStatusPayload,
} from '@/types/orders';

export function fetchOrders() {
  return apiClient.get<ApiEnvelope<OrderRecord[]>>('/orders');
}

export function fetchOrderDetail(id: string) {
  return apiClient.get<ApiEnvelope<OrderDetailRecord>>(`/orders/${id}`);
}

export function createOrder(payload: CreateOrderPayload) {
  return apiClient.post<ApiEnvelope<OrderRecord>>('/orders', payload);
}

export function updateOrderStatus(id: string, payload: UpdateOrderStatusPayload) {
  return apiClient.post<ApiEnvelope<OrderDetailRecord>>(`/orders/${id}/status`, payload);
}

export function deleteOrder(id: string, options?: { aggressive?: boolean }) {
  const aggressive = options?.aggressive ? '?aggressive=1' : '';
  return apiClient.delete<ApiEnvelope<DeleteOrderResponse>>(`/orders/${id}${aggressive}`);
}
