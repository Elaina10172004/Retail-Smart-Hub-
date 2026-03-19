import type {
  CreateProductPayload,
  CreateRolePayload,
  CreateSupplierPayload,
  CreateUserPayload,
  CreateWarehousePayload,
} from '@/types/settings';

export type SectionId = 'account' | 'access' | 'master' | 'logs';

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

export const defaultRoleForm: CreateRolePayload = {
  name: '',
  description: '',
  scope: 'operations',
  templateRoleId: '',
};

export const defaultWarehouseForm: CreateWarehousePayload = {
  name: '',
  locationCode: '',
  capacity: 1000,
};
