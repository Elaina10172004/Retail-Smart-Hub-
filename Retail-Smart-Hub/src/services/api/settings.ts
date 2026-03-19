import { apiClient } from '@/services/api/client';
import type { ApiEnvelope } from '@/types/api';
import type { ImportBatchResult, ImportSourceRow } from '@/types/import';
import type {
  AccessOverview,
  CreateUserResult,
  CreateProductPayload,
  CreateRolePayload,
  CreateSupplierPayload,
  CreateUserPayload,
  CreateWarehousePayload,
  MasterDataOverview,
  ProductRecord,
  ResetUserPasswordPayload,
  RoleRecord,
  SensitiveVerificationPayload,
  SupplierRecord,
  UpdateProductPayload,
  UpdateRolePermissionsPayload,
  UpdateSupplierPayload,
  UpdateUserRolePayload,
  UpdateWarehousePayload,
  UserRecord,
  WarehouseRecord,
} from '@/types/settings';

export function fetchAccessOverview() {
  return apiClient.get<ApiEnvelope<AccessOverview>>('/settings/access');
}

export function fetchMasterDataOverview() {
  return apiClient.get<ApiEnvelope<MasterDataOverview>>('/settings/master-data');
}

export function createUser(payload: CreateUserPayload) {
  return apiClient.post<ApiEnvelope<CreateUserResult>>('/settings/users', payload);
}

export function toggleUserStatus(id: string) {
  return apiClient.post<ApiEnvelope<UserRecord>>(`/settings/users/${id}/toggle-status`);
}

export function resetManagedUserPassword(id: string, payload: ResetUserPasswordPayload) {
  return apiClient.post<ApiEnvelope<boolean>>(`/settings/users/${id}/reset-password`, payload);
}

export function deleteUser(id: string, payload: SensitiveVerificationPayload) {
  return apiClient.post<ApiEnvelope<boolean>>(`/settings/users/${id}/delete`, payload);
}

export function updateUserRole(id: string, payload: UpdateUserRolePayload) {
  return apiClient.post<ApiEnvelope<UserRecord>>(`/settings/users/${id}/role`, payload);
}

export function createRole(payload: CreateRolePayload) {
  return apiClient.post<ApiEnvelope<RoleRecord>>('/settings/roles', payload);
}

export function deleteRole(id: string, payload: SensitiveVerificationPayload) {
  return apiClient.post<ApiEnvelope<boolean>>(`/settings/roles/${id}/delete`, payload);
}

export function updateRolePermissions(id: string, payload: UpdateRolePermissionsPayload) {
  return apiClient.post<ApiEnvelope<RoleRecord>>(`/settings/roles/${id}/permissions`, payload);
}

export function createSupplier(payload: CreateSupplierPayload) {
  return apiClient.post<ApiEnvelope<SupplierRecord>>('/settings/suppliers', payload);
}

export function updateSupplier(id: string, payload: UpdateSupplierPayload) {
  return apiClient.post<ApiEnvelope<SupplierRecord>>(`/settings/suppliers/${id}`, payload);
}

export function toggleSupplierStatus(id: string) {
  return apiClient.post<ApiEnvelope<SupplierRecord>>(`/settings/suppliers/${id}/toggle-status`);
}

export function deleteSupplier(id: string) {
  return apiClient.post<ApiEnvelope<boolean>>(`/settings/suppliers/${id}/delete`);
}

export function createWarehouse(payload: CreateWarehousePayload) {
  return apiClient.post<ApiEnvelope<WarehouseRecord>>('/settings/warehouses', payload);
}

export function updateWarehouse(id: string, payload: UpdateWarehousePayload) {
  return apiClient.post<ApiEnvelope<WarehouseRecord>>(`/settings/warehouses/${id}`, payload);
}

export function deleteWarehouse(id: string) {
  return apiClient.post<ApiEnvelope<boolean>>(`/settings/warehouses/${id}/delete`);
}

export function createProduct(payload: CreateProductPayload) {
  return apiClient.post<ApiEnvelope<ProductRecord>>('/settings/products', payload);
}

export function updateProduct(id: string, payload: UpdateProductPayload) {
  return apiClient.post<ApiEnvelope<ProductRecord>>(`/settings/products/${id}`, payload);
}

export function toggleProductStatus(id: string) {
  return apiClient.post<ApiEnvelope<ProductRecord>>(`/settings/products/${id}/toggle-status`);
}

export function deleteProduct(id: string) {
  return apiClient.post<ApiEnvelope<boolean>>(`/settings/products/${id}/delete`);
}

export function importProducts(rows: ImportSourceRow[]) {
  return apiClient.post<ApiEnvelope<ImportBatchResult>>('/settings/products/import', { rows });
}
