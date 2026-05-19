import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import { type MaybePaginated, type PageQueryParams, pageQuery, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  CreateOrderPayload,
  DeleteOrderResponse,
  OrderDetailRecord,
  OrderFormOptions,
  OrderRecord,
  UpdateOrderStatusPayload,
} from '@/types/orders';

export async function fetchOrders(params?: PageQueryParams) {
  const qs = pageQuery(params || { pageSize: 100 });
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<OrderRecord>>>(`/orders${qs}`);
  return unwrapPaginatedEnvelope(response);
}

export async function fetchOrdersPaginated(params?: PageQueryParams) {
  const qs = pageQuery(params || { pageSize: 20 });
  return apiClient.get<ApiEnvelope<PaginatedData<OrderRecord>>>(`/orders${qs}`);
}

export function fetchOrderDetail(id: string) {
  return apiClient.get<ApiEnvelope<OrderDetailRecord>>(`/orders/${id}`);
}

export function fetchOrderFormOptions() {
  return apiClient.get<ApiEnvelope<OrderFormOptions>>('/orders/form-options');
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
