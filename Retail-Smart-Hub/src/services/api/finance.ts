import { apiClient } from '@/services/api/client';
import type { ApiEnvelope, PaginatedData } from '@/types/api';
import { type MaybePaginated, type PageQueryParams, pageQuery, unwrapPaginatedEnvelope } from '@/services/api/pagination';
import type {
  FinanceActionPayload,
  FinanceOverview,
  PayableDetailRecord,
  PayableRecord,
  PaymentRecord,
  ReceivableDetailRecord,
  ReceivableRecord,
  ReceiptRecord,
} from '@/types/finance';

export function fetchFinanceOverview() {
  return apiClient.get<ApiEnvelope<FinanceOverview>>('/finance/overview');
}

export async function fetchReceivables() {
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<ReceivableRecord>>>('/finance/receivables?pageSize=100');
  return unwrapPaginatedEnvelope(response);
}

export function fetchReceivablesPaginated(params?: PageQueryParams) {
  return apiClient.get<ApiEnvelope<PaginatedData<ReceivableRecord>>>(`/finance/receivables${pageQuery(params)}`);
}

export function fetchReceivableDetail(id: string) {
  return apiClient.get<ApiEnvelope<ReceivableDetailRecord>>(`/finance/receivables/${id}`);
}

export function fetchReceiptRecords(receivableId?: string) {
  const suffix = receivableId ? `?receivableId=${encodeURIComponent(receivableId)}` : '';
  return apiClient.get<ApiEnvelope<ReceiptRecord[]>>(`/finance/receipts${suffix}`);
}

export async function fetchPayables() {
  const response = await apiClient.get<ApiEnvelope<MaybePaginated<PayableRecord>>>('/finance/payables?pageSize=100');
  return unwrapPaginatedEnvelope(response);
}

export function fetchPayablesPaginated(params?: PageQueryParams) {
  return apiClient.get<ApiEnvelope<PaginatedData<PayableRecord>>>(`/finance/payables${pageQuery(params)}`);
}

export function fetchPayableDetail(id: string) {
  return apiClient.get<ApiEnvelope<PayableDetailRecord>>(`/finance/payables/${id}`);
}

export function fetchPaymentRecords(payableId?: string) {
  const suffix = payableId ? `?payableId=${encodeURIComponent(payableId)}` : '';
  return apiClient.get<ApiEnvelope<PaymentRecord[]>>(`/finance/payments${suffix}`);
}

export function receiveReceivable(id: string, payload: FinanceActionPayload) {
  return apiClient.post<ApiEnvelope<ReceivableRecord>>(`/finance/receivables/${id}/receive`, payload);
}

export function payPayable(id: string, payload: FinanceActionPayload) {
  return apiClient.post<ApiEnvelope<PayableRecord>>(`/finance/payables/${id}/pay`, payload);
}
