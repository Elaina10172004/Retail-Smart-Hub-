import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import type {
  CreateOrderPayload,
  DeleteOrderResponse,
  OrderDetailRecord,
  OrderFormOptions,
  OrderRecord,
  UpdateOrderStatusPayload,
} from '@/types/orders';

type OrdersResponseData = OrderRecord[] | PaginatedData<OrderRecord>;

function unwrapOrderList(data: OrdersResponseData) {
  return Array.isArray(data) ? data : data.items;
}

export async function fetchOrders() {
  const response = await apiClient.get<ApiEnvelope<OrdersResponseData>>('/orders?pageSize=100');
  return {
    ...response,
    data: unwrapOrderList(response.data),
  } satisfies ApiEnvelope<OrderRecord[]>;
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
