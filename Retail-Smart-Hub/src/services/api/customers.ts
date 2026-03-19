import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type {
  CreateCustomerPayload,
  CustomerDetailRecord,
  CustomerRecord,
  CustomerSummary,
  UpdateCustomerPayload,
} from '@/types/customers';
import type { ImportBatchResult, ImportSourceRow } from '@/types/import';

export function fetchCustomerSummary() {
  return apiClient.get<ApiEnvelope<CustomerSummary>>('/customers/overview');
}

export function fetchCustomers() {
  return apiClient.get<ApiEnvelope<CustomerRecord[]>>('/customers');
}

export function fetchCustomerDetail(id: string) {
  return apiClient.get<ApiEnvelope<CustomerDetailRecord>>(`/customers/${id}`);
}

export function createCustomer(payload: CreateCustomerPayload) {
  return apiClient.post<ApiEnvelope<CustomerRecord>>('/customers', payload);
}

export function updateCustomer(id: string, payload: UpdateCustomerPayload) {
  return apiClient.put<ApiEnvelope<CustomerRecord>>(`/customers/${id}`, payload);
}

export function deleteCustomer(id: string) {
  return apiClient.delete<ApiEnvelope<boolean>>(`/customers/${id}`);
}

export function toggleCustomerStatus(id: string) {
  return apiClient.post<ApiEnvelope<CustomerRecord>>(`/customers/${id}/toggle-status`);
}

export function importCustomers(rows: ImportSourceRow[]) {
  return apiClient.post<ApiEnvelope<ImportBatchResult>>('/customers/import', { rows });
}
