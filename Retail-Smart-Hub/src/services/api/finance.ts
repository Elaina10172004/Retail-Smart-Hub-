import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
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

export function fetchReceivables() {
  return apiClient.get<ApiEnvelope<ReceivableRecord[]>>('/finance/receivables');
}

export function fetchReceivableDetail(id: string) {
  return apiClient.get<ApiEnvelope<ReceivableDetailRecord>>(`/finance/receivables/${id}`);
}

export function fetchReceiptRecords(receivableId?: string) {
  const suffix = receivableId ? `?receivableId=${encodeURIComponent(receivableId)}` : '';
  return apiClient.get<ApiEnvelope<ReceiptRecord[]>>(`/finance/receipts${suffix}`);
}

export function fetchPayables() {
  return apiClient.get<ApiEnvelope<PayableRecord[]>>('/finance/payables');
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
