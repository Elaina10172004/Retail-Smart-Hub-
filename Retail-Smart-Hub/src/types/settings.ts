export interface AccessSummary {
  userCount: number;
  activeUserCount: number;
  roleCount: number;
  permissionCount: number;
  currentUser: {
    username: string;
    email: string;
    department: string;
    roles: string[];
  } | null;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  phone: string;
  department: string;
  status: 'active' | 'inactive';
  roles: string[];
  isProtected: boolean;
  canDelete: boolean;
}

export interface RoleRecord {
  id: string;
  name: string;
  description: string;
  scope: string;
  userCount: number;
  permissionCount: number;
  permissionCodes: string[];
  isProtected: boolean;
  canDelete: boolean;
}

export interface RoleTemplateRecord {
  id: string;
  name: string;
  scope: string;
  description: string;
  recommendedFor: string;
  securityLevel: string;
  keyPermissions: string[];
  basedOnRoleId?: string;
}

export interface SecurityLevelRecord {
  level: string;
  title: string;
  description: string;
  verification: string;
  typicalActions: string[];
}

export interface PermissionRecord {
  id: string;
  code: string;
  label: string;
  moduleId: string;
}

export interface AccessOverview {
  summary: AccessSummary;
  users: UserRecord[];
  roles: RoleRecord[];
  permissions: PermissionRecord[];
  roleTemplates: RoleTemplateRecord[];
  securityLevels: SecurityLevelRecord[];
}

export interface SupplierRecord {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  leadTimeDays: number;
  status: string;
  canDelete: boolean;
}

export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  status: string;
  safeStock: number;
  salePrice: number;
  costPrice: number;
  preferredSupplierId: string;
  preferredSupplier: string;
  canDelete: boolean;
}

export interface WarehouseRecord {
  id: string;
  name: string;
  locationCode: string;
  capacity: number;
  currentStock: number;
  canDelete: boolean;
}

export interface MasterDataSummary {
  supplierCount: number;
  productCount: number;
  warehouseCount: number;
  lowStockProductCount: number;
}

export interface MasterDataOverview {
  summary: MasterDataSummary;
  suppliers: SupplierRecord[];
  products: ProductRecord[];
  warehouses: WarehouseRecord[];
}

export interface CreateUserPayload {
  username: string;
  email: string;
  phone?: string;
  department: string;
  roleId: string;
}

export interface CreateUserResult {
  user: UserRecord;
  temporaryPassword: string;
  temporaryPasswordIssuedAt: string;
}

export interface CreateSupplierPayload {
  name: string;
  contactName?: string;
  phone?: string;
  leadTimeDays: number;
}

export interface CreateProductPayload {
  sku: string;
  name: string;
  category: string;
  unit: string;
  safeStock: number;
  salePrice: number;
  costPrice: number;
  preferredSupplierId: string;
}

export interface CreateRolePayload {
  name: string;
  description?: string;
  scope: string;
  templateRoleId?: string;
}

export interface CreateWarehousePayload {
  name: string;
  locationCode: string;
  capacity: number;
}

export interface UpdateSupplierPayload {
  name: string;
  contactName?: string;
  phone?: string;
  leadTimeDays: number;
}

export interface UpdateProductPayload {
  sku: string;
  name: string;
  category: string;
  unit: string;
  safeStock: number;
  salePrice: number;
  costPrice: number;
  preferredSupplierId: string;
}

export interface UpdateWarehousePayload {
  name: string;
  locationCode: string;
  capacity: number;
}

export interface UpdateUserRolePayload {
  roleId: string;
  verifyPassword: string;
}

export interface UpdateRolePermissionsPayload {
  permissionCodes: string[];
  verifyPassword: string;
}

export interface ResetUserPasswordPayload {
  newPassword: string;
  verifyPassword: string;
}

export interface SensitiveVerificationPayload {
  verifyPassword: string;
}
