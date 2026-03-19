import type { CreateProductPayload, CreateSupplierPayload, CreateUserPayload } from '@/types/settings';

export type SettingsSection = 'access' | 'suppliers' | 'products' | 'warehouses';

export const defaultUserForm: CreateUserPayload = {
  username: '',
  email: '',
  phone: '',
  department: '运营部',
  roleId: '',
};

export const defaultSupplierForm: CreateSupplierPayload = {
  name: '',
  contactName: '',
  phone: '',
  leadTimeDays: 3,
};

export const defaultProductForm: CreateProductPayload = {
  sku: '',
  name: '',
  category: '日用百货',
  unit: '件',
  safeStock: 30,
  salePrice: 0,
  costPrice: 0,
  preferredSupplierId: '',
};
