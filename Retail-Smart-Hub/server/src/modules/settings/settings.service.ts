import { appendAuditLog, db, ensureAccessControlData, ensureAuthSecurityData, nextMasterDataId } from '../../database/db';
import { issueTemporaryPasswordForUser } from '../../shared/auth';

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

export interface CreateUserResult {
  user: UserRecord;
  temporaryPassword: string;
  temporaryPasswordIssuedAt: string;
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
  status: 'active' | 'inactive';
  canDelete: boolean;
}

export interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  status: 'active' | 'inactive';
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
}

export interface UpdateRolePermissionsPayload {
  permissionCodes: string[];
}

export interface ImportSourceRow {
  [key: string]: unknown;
}

export interface ImportRowError {
  rowNumber: number;
  identifier: string;
  reason: string;
}

export interface ImportBatchResult {
  totalCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  createdIds: string[];
  errors: ImportRowError[];
}

const protectedRoleIds = new Set(['ROLE-001', 'ROLE-002', 'ROLE-003', 'ROLE-004', 'ROLE-005']);
const protectedUserIds = new Set(['USR-001']);

interface UserRow {
  id: string;
  username: string;
  email: string;
  phone: string | null;
  department: string;
  status: 'active' | 'inactive';
  roles: string | null;
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  userCount: number;
  permissionCount: number;
  permissionCodes: string | null;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  status: 'active' | 'inactive' | null;
  safeStock: number;
  salePrice: number;
  costPrice: number;
  preferredSupplierId: string | null;
  preferredSupplier: string | null;
}

function nextEntityId(tableName: string, prefix: string) {
  return nextMasterDataId(tableName, prefix);
}

function parseRoles(value: string | null) {
  return value ? value.split(',').filter(Boolean) : [];
}

function normalizeImportKey(value: string) {
  return value.toLowerCase().replace(/[\s_\-()（）[\]{}:：/\\]/g, '');
}

function pickImportValue(row: ImportSourceRow, aliases: string[]) {
  const normalizedAliasSet = new Set(aliases.map((alias) => normalizeImportKey(alias)));
  const matchedEntry = Object.entries(row).find(([key]) => normalizedAliasSet.has(normalizeImportKey(key)));
  return matchedEntry?.[1];
}

function normalizeOptionalString(value: unknown) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim();
  }

  return '';
}

function parseNonNegativeInteger(value: unknown, fallback: number | null = null) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function parsePositiveNumber(value: unknown) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function resolveActiveSupplierReference(reference: string) {
  const normalized = reference.trim();
  if (!normalized) {
    return null;
  }

  return (
    db.prepare<{ id: string; name: string }>("SELECT id, name FROM suppliers WHERE id = ? AND status = 'active'").get(normalized) ||
    db.prepare<{ id: string; name: string }>("SELECT id, name FROM suppliers WHERE name = ? AND status = 'active'").get(normalized)
  );
}

function buildSecurityLevels(): SecurityLevelRecord[] {
  return [
    {
      level: 'L1',
      title: '只读查询',
      description: '只读取订单、库存、报表、审计等数据，不触发任何真实写入。',
      verification: '登录态校验',
      typicalActions: ['查看订单详情', '查看库存预警', '查询报表口径'],
    },
    {
      level: 'L2',
      title: '低风险维护',
      description: '修改基础资料或停用对象，不直接影响库存与资金。',
      verification: '登录态校验 + 权限校验',
      typicalActions: ['编辑商品资料', '停用供应商', '切换用户状态'],
    },
    {
      level: 'L3',
      title: '业务执行',
      description: '推进单据状态、发货、入库、建单等，直接影响业务流。',
      verification: '登录态校验 + 权限校验 + AI 待确认/页面确认',
      typicalActions: ['确认入库', '确认发货', '创建销售订单'],
    },
    {
      level: 'L4',
      title: '高敏感操作',
      description: '影响资金、权限或安全状态，要求更严格的人工确认。',
      verification: '登录态校验 + 权限校验 + 二次密码验证',
      typicalActions: ['登记收款/付款', '重置用户密码', '修改角色权限'],
    },
  ];
}

function buildRoleTemplates(roles: RoleRecord[]): RoleTemplateRecord[] {
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const templates: Array<Omit<RoleTemplateRecord, 'basedOnRoleId'>> = [
    {
      id: 'TEMPLATE-ADMIN',
      name: '系统管理员模板',
      scope: 'global',
      description: '覆盖系统设置、业务操作、财务和 AI 工具的全量模板。',
      recommendedFor: '项目负责人、系统管理员',
      securityLevel: 'L4',
      keyPermissions: ['settings.access-control', 'settings.master-data', 'finance.view', 'finance.receivable', 'finance.payable'],
    },
    {
      id: 'TEMPLATE-OPS',
      name: '运营主管模板',
      scope: 'operations',
      description: '覆盖订单、库存、采购、到货、入库、发货等日常运营链路。',
      recommendedFor: '运营主管、仓储主管',
      securityLevel: 'L3',
      keyPermissions: ['orders.create', 'inventory.view', 'inventory.write', 'procurement.manage', 'shipping.dispatch'],
    },
    {
      id: 'TEMPLATE-FINANCE',
      name: '财务专员模板',
      scope: 'finance',
      description: '聚焦应收、应付、报表和审计查询，不开放业务主数据维护。',
      recommendedFor: '财务专员、财务主管',
      securityLevel: 'L4',
      keyPermissions: ['finance.view', 'finance.receivable', 'finance.payable', 'reports.view'],
    },
    {
      id: 'TEMPLATE-SERVICE',
      name: '客服与销售内勤模板',
      scope: 'sales',
      description: '聚焦客户、订单、消息和报表，适合对客和订单跟进岗位。',
      recommendedFor: '客服、销售内勤、订单专员',
      securityLevel: 'L3',
      keyPermissions: ['orders.view', 'orders.create', 'settings.master-data'],
    },
  ];

  return templates.map((template) => {
    const basedOnRole = Array.from(roleByName.values()).find((role) => role.permissionCodes.some((code) => template.keyPermissions.includes(code)));
    return {
      ...template,
      basedOnRoleId: basedOnRole?.id,
    };
  });
}

function hasProductBusinessReferences(productId: string) {
  return [
    'sales_order_items',
    'purchase_order_items',
    'receiving_note_items',
    'stock_out_records',
  ].some((table) => {
    const count = db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM ${table} WHERE product_id = ?`).get(productId)?.count ?? 0;
    return count > 0;
  });
}

function hasWarehouseBusinessReferences(warehouseId: string) {
  const inboundRefs = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM inbound_orders WHERE warehouse_id = ?').get(warehouseId)?.count ?? 0;
  const stockOutRefs = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM stock_out_records WHERE warehouse_id = ?').get(warehouseId)?.count ?? 0;
  return inboundRefs > 0 || stockOutRefs > 0;
}

function canDeleteSupplierRecord(supplierId: string, status: 'active' | 'inactive') {
  if (status !== 'inactive') {
    return false;
  }

  const productReferenceCount =
    db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM products WHERE preferred_supplier_id = ?').get(supplierId)?.count ?? 0;
  const purchaseReferenceCount =
    db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM purchase_orders WHERE supplier_id = ?').get(supplierId)?.count ?? 0;

  return productReferenceCount === 0 && purchaseReferenceCount === 0;
}

function canDeleteProductRecord(productId: string, status: 'active' | 'inactive') {
  if (status !== 'inactive') {
    return false;
  }

  const stockRows = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM inventory WHERE product_id = ? AND (current_stock > 0 OR reserved_stock > 0)'
  ).get(productId)?.count ?? 0;

  return !hasProductBusinessReferences(productId) && stockRows === 0;
}

function canDeleteWarehouseRecord(warehouseId: string) {
  const stockRows = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM inventory WHERE warehouse_id = ? AND (current_stock > 0 OR reserved_stock > 0)'
  ).get(warehouseId)?.count ?? 0;

  return stockRows === 0 && !hasWarehouseBusinessReferences(warehouseId);
}

function loadUsers() {
  ensureAccessControlData();

  return db.prepare<UserRow>(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.phone,
      u.department,
      u.status,
      GROUP_CONCAT(r.name, ',') as roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    GROUP BY u.id, u.username, u.email, u.phone, u.department, u.status
    ORDER BY u.id ASC
  `).all();
}

function loadRoles() {
  ensureAccessControlData();

  return db.prepare<RoleRow>(`
    SELECT
      r.id,
      r.name,
      r.description,
      r.scope,
      COUNT(DISTINCT ur.user_id) as userCount,
      COUNT(DISTINCT rp.permission_id) as permissionCount,
      GROUP_CONCAT(DISTINCT p.code) as permissionCodes
    FROM roles r
    LEFT JOIN user_roles ur ON ur.role_id = r.id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
    GROUP BY r.id, r.name, r.description, r.scope
    ORDER BY r.id ASC
  `).all();
}

function loadPermissions() {
  ensureAccessControlData();

  return db.prepare<PermissionRecord>(`
    SELECT
      id,
      code,
      label,
      module_id as moduleId
    FROM permissions
    ORDER BY module_id ASC, code ASC
  `).all();
}

function loadSuppliers() {
  return db.prepare<SupplierRecord>(`
    SELECT
      id,
      name,
      COALESCE(contact_name, '') as contactName,
      COALESCE(phone, '') as phone,
      lead_time_days as leadTimeDays,
      COALESCE(status, 'active') as status
    FROM suppliers
    ORDER BY id ASC
  `).all();
}

function loadProducts() {
  return db.prepare<ProductRow>(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.category,
      p.unit,
      COALESCE(p.status, 'active') as status,
      p.safe_stock as safeStock,
      p.sale_price as salePrice,
      p.cost_price as costPrice,
      p.preferred_supplier_id as preferredSupplierId,
      s.name as preferredSupplier
    FROM products p
    LEFT JOIN suppliers s ON s.id = p.preferred_supplier_id
    ORDER BY p.sku ASC
  `).all();
}

function loadWarehouses() {
  return db.prepare<WarehouseRecord>(`
    SELECT
      w.id,
      w.name,
      w.location_code as locationCode,
      w.capacity,
      COALESCE(SUM(i.current_stock), 0) as currentStock
    FROM warehouses w
    LEFT JOIN inventory i ON i.warehouse_id = w.id
    GROUP BY w.id, w.name, w.location_code, w.capacity
    ORDER BY w.id ASC
  `).all();
}

export function getAccessOverview(): AccessOverview {
  const users = loadUsers().map((user) => ({
    ...user,
    phone: user.phone ?? '-',
    roles: parseRoles(user.roles),
    isProtected: protectedUserIds.has(user.id),
    canDelete: !protectedUserIds.has(user.id) && user.status === 'inactive',
  }));
  const roles = loadRoles().map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description ?? '',
    scope: role.scope,
    userCount: role.userCount,
    permissionCount: role.permissionCount,
    permissionCodes: parseRoles(role.permissionCodes),
    isProtected: protectedRoleIds.has(role.id),
    canDelete: !protectedRoleIds.has(role.id) && role.userCount === 0,
  }));
  const permissions = loadPermissions();
  const securityLevels = buildSecurityLevels();
  const roleTemplates = buildRoleTemplates(roles);
  const currentUser = users.find((user) => user.roles.includes('系统管理员')) ?? users[0] ?? null;

  return {
    summary: {
      userCount: users.length,
      activeUserCount: users.filter((user) => user.status === 'active').length,
      roleCount: roles.length,
      permissionCount: permissions.length,
      currentUser:
        currentUser
          ? {
              username: currentUser.username,
              email: currentUser.email,
              department: currentUser.department,
              roles: currentUser.roles,
            }
          : null,
    },
    users,
    roles,
    permissions,
    roleTemplates,
    securityLevels,
  };
}

export function getMasterDataOverview(): MasterDataOverview {
  const suppliers = loadSuppliers().map((supplier) => ({
    ...supplier,
    canDelete: canDeleteSupplierRecord(supplier.id, supplier.status),
  }));
  const products = loadProducts().map((product) => ({
    ...product,
    status: product.status ?? 'active',
    preferredSupplierId: product.preferredSupplierId ?? '',
    preferredSupplier: product.preferredSupplier ?? '-',
    canDelete: canDeleteProductRecord(product.id, product.status ?? 'active'),
  }));
  const warehouses = loadWarehouses().map((warehouse) => ({
    ...warehouse,
    canDelete: canDeleteWarehouseRecord(warehouse.id),
  }));

  const lowStockProductCount =
    db.prepare<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id
        GROUP BY p.id, p.safe_stock
        HAVING COALESCE(SUM(i.current_stock), 0) < p.safe_stock
      )
    `).get()?.count ?? 0;

  return {
    summary: {
      supplierCount: suppliers.length,
      productCount: products.length,
      warehouseCount: warehouses.length,
      lowStockProductCount,
    },
    suppliers,
    products,
    warehouses,
  };
}

export function createUser(payload: CreateUserPayload): CreateUserResult {
  ensureAccessControlData();
  ensureAuthSecurityData();

  const role = db.prepare<{ id: string }>('SELECT id FROM roles WHERE id = ?').get(payload.roleId);
  if (!role) {
    throw new Error('Role not found');
  }

  const duplicate = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM users WHERE username = ? OR email = ?'
  ).get(payload.username.trim(), payload.email.trim())?.count ?? 0;

  if (duplicate > 0) {
    throw new Error('Username or email already exists');
  }

  const userId = nextEntityId('users', 'USR');
  const temporaryPasswordIssuedAt = new Date().toISOString();
  let temporaryPassword = '';

  const transaction = db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, username, email, phone, department, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      userId,
      payload.username.trim(),
      payload.email.trim(),
      payload.phone?.trim() || null,
      payload.department.trim(),
      'active'
    );

    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, payload.roleId);
    db.prepare(
      'INSERT INTO user_credentials (user_id, password, password_updated_at, must_change_password, temporary_password_issued_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      userId,
      '',
      temporaryPasswordIssuedAt,
      1,
      temporaryPasswordIssuedAt
    );
    db.prepare(
      'INSERT OR IGNORE INTO auth_security_state (user_id, failed_attempt_count, last_failed_at, locked_until, password_updated_at) VALUES (?, 0, NULL, NULL, ?)'
    ).run(userId, temporaryPasswordIssuedAt);

    temporaryPassword = issueTemporaryPasswordForUser(userId, 'SYSTEM_AUTO');

    appendAuditLog('create_user', 'user', userId, {
      roleId: payload.roleId,
      department: payload.department,
      temporaryPasswordIssuedAt,
    });
  });

  transaction();

  return {
    user: getAccessOverview().users.find((user) => user.id === userId) as UserRecord,
    temporaryPassword,
    temporaryPasswordIssuedAt,
  };
}

export function toggleUserStatus(userId: string) {
  ensureAccessControlData();

  const user = db.prepare<{ status: 'active' | 'inactive' }>('SELECT status FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const nextStatus = user.status === 'active' ? 'inactive' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, userId);

  appendAuditLog('toggle_user_status', 'user', userId, {
    status: nextStatus,
  });

  return getAccessOverview().users.find((item) => item.id === userId) as UserRecord;
}

export function updateUserRole(userId: string, payload: UpdateUserRolePayload) {
  ensureAccessControlData();

  const user = db.prepare<{ id: string }>('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const role = db.prepare<{ id: string }>('SELECT id FROM roles WHERE id = ?').get(payload.roleId);
  if (!role) {
    throw new Error('Role not found');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, payload.roleId);

    appendAuditLog('change_user_role', 'user', userId, {
      roleId: payload.roleId,
    });
  });

  transaction();

  return getAccessOverview().users.find((item) => item.id === userId) as UserRecord;
}

export function deleteUser(userId: string, actorUserId: string) {
  ensureAccessControlData();

  const user = db.prepare<{ id: string; username: string; status: 'active' | 'inactive' }>(
    'SELECT id, username, status FROM users WHERE id = ?'
  ).get(userId);
  if (!user) {
    throw new Error('User not found');
  }

  if (userId === actorUserId) {
    throw new Error('Current user cannot delete itself');
  }

  if (protectedUserIds.has(userId)) {
    throw new Error('Protected user cannot be deleted');
  }

  if (user.status !== 'inactive') {
    throw new Error('User must be inactive before deletion');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  appendAuditLog('delete_user', 'user', userId, {
    username: user.username,
    by: actorUserId,
  });
}

export function updateRolePermissions(roleId: string, payload: UpdateRolePermissionsPayload) {
  ensureAccessControlData();

  const role = db.prepare<{ id: string }>('SELECT id FROM roles WHERE id = ?').get(roleId);
  if (!role) {
    throw new Error('Role not found');
  }

  const permissionCodes = Array.from(
    new Set(payload.permissionCodes.map((item) => item.trim()).filter(Boolean))
  );
  const permissionRows = permissionCodes.length
    ? db
        .prepare<{ id: string; code: string }>(
          `SELECT id, code FROM permissions WHERE code IN (${permissionCodes.map(() => '?').join(', ')})`
        )
        .all(...permissionCodes)
    : [];

  if (permissionRows.length !== permissionCodes.length) {
    throw new Error('Some permissions are invalid');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    const insert = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    permissionRows.forEach((permission) => insert.run(roleId, permission.id));

    appendAuditLog('update_role_permissions', 'role', roleId, {
      permissionCodes,
    });
  });

  transaction();

  return getAccessOverview().roles.find((item) => item.id === roleId) as RoleRecord;
}

export function createRole(payload: CreateRolePayload) {
  ensureAccessControlData();

  const name = payload.name.trim();
  const description = payload.description?.trim() || '';
  const scope = payload.scope.trim();

  if (!name) {
    throw new Error('Role name is required');
  }

  if (!scope) {
    throw new Error('Role scope is required');
  }

  const duplicate = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM roles WHERE name = ?').get(name)?.count ?? 0;
  if (duplicate > 0) {
    throw new Error('Role name already exists');
  }

  let permissionRows: Array<{ permissionId: string }> = [];

  if (payload.templateRoleId?.trim()) {
    const templateRoleId = payload.templateRoleId.trim();
    const templateRole = db.prepare<{ id: string }>('SELECT id FROM roles WHERE id = ?').get(templateRoleId);
    if (!templateRole) {
      throw new Error('Template role not found');
    }

    permissionRows = db
      .prepare<{ permissionId: string }>('SELECT permission_id as permissionId FROM role_permissions WHERE role_id = ?')
      .all(templateRoleId);
  }

  const roleId = nextEntityId('roles', 'ROLE');

  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO roles (id, name, description, scope) VALUES (?, ?, ?, ?)').run(
      roleId,
      name,
      description || null,
      scope
    );

    if (permissionRows.length > 0) {
      const insertPermission = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
      permissionRows.forEach((permission) => insertPermission.run(roleId, permission.permissionId));
    }

    appendAuditLog('create_role', 'role', roleId, {
      name,
      scope,
      templateRoleId: payload.templateRoleId?.trim() || null,
    });
  });

  transaction();

  return getAccessOverview().roles.find((item) => item.id === roleId) as RoleRecord;
}

export function deleteRole(roleId: string) {
  ensureAccessControlData();

  const role = db.prepare<{ id: string; name: string }>('SELECT id, name FROM roles WHERE id = ?').get(roleId);
  if (!role) {
    throw new Error('Role not found');
  }

  if (protectedRoleIds.has(roleId)) {
    throw new Error('Protected role cannot be deleted');
  }

  const assignedUsers = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM user_roles WHERE role_id = ?').get(roleId)?.count ?? 0;
  if (assignedUsers > 0) {
    throw new Error('Role is assigned to users and cannot be deleted');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);

    appendAuditLog('delete_role', 'role', roleId, {
      name: role.name,
    });
  });

  transaction();
}

export function createSupplier(payload: CreateSupplierPayload) {
  const duplicate = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM suppliers WHERE name = ?').get(
    payload.name.trim()
  )?.count ?? 0;

  if (duplicate > 0) {
    throw new Error('Supplier already exists');
  }

  const supplierId = nextEntityId('suppliers', 'SUP');

  db.prepare(
    'INSERT INTO suppliers (id, name, contact_name, phone, lead_time_days, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    supplierId,
    payload.name.trim(),
    payload.contactName?.trim() || null,
    payload.phone?.trim() || null,
    payload.leadTimeDays,
    'active'
  );

  appendAuditLog('create_supplier', 'supplier', supplierId, {
    name: payload.name,
  });

  return getMasterDataOverview().suppliers.find((item) => item.id === supplierId) as SupplierRecord;
}

export function updateSupplier(supplierId: string, payload: UpdateSupplierPayload) {
  const supplier = db.prepare<{ id: string }>('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) {
    throw new Error('Supplier not found');
  }

  const name = payload.name.trim();
  if (!name) {
    throw new Error('Supplier name is required');
  }

  if (!Number.isInteger(payload.leadTimeDays) || payload.leadTimeDays <= 0) {
    throw new Error('Lead time days must be a positive integer');
  }

  const duplicate = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM suppliers WHERE name = ? AND id <> ?'
  ).get(name, supplierId)?.count ?? 0;

  if (duplicate > 0) {
    throw new Error('Supplier already exists');
  }

  db.prepare(
    'UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, lead_time_days = ? WHERE id = ?'
  ).run(name, payload.contactName?.trim() || null, payload.phone?.trim() || null, payload.leadTimeDays, supplierId);

  appendAuditLog('update_supplier', 'supplier', supplierId, {
    name,
    leadTimeDays: payload.leadTimeDays,
  });

  return getMasterDataOverview().suppliers.find((item) => item.id === supplierId) as SupplierRecord;
}

export function toggleSupplierStatus(supplierId: string) {
  const supplier = db.prepare<{ status: 'active' | 'inactive' }>('SELECT status FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) {
    throw new Error('Supplier not found');
  }

  const nextStatus = supplier.status === 'active' ? 'inactive' : 'active';
  db.prepare('UPDATE suppliers SET status = ? WHERE id = ?').run(nextStatus, supplierId);

  appendAuditLog('toggle_supplier_status', 'supplier', supplierId, {
    status: nextStatus,
  });

  return getMasterDataOverview().suppliers.find((item) => item.id === supplierId) as SupplierRecord;
}

export function deleteSupplier(supplierId: string) {
  const supplier = db.prepare<{ id: string; name: string; status: 'active' | 'inactive' }>(
    "SELECT id, name, COALESCE(status, 'active') as status FROM suppliers WHERE id = ?"
  ).get(supplierId);
  if (!supplier) {
    throw new Error('Supplier not found');
  }

  if (supplier.status !== 'inactive') {
    throw new Error('Supplier must be inactive before deletion');
  }

  if (!canDeleteSupplierRecord(supplierId, supplier.status)) {
    throw new Error('Supplier is referenced by products or purchase orders and cannot be deleted');
  }

  db.prepare('DELETE FROM suppliers WHERE id = ?').run(supplierId);

  appendAuditLog('delete_supplier', 'supplier', supplierId, {
    name: supplier.name,
  });
}

export function createProduct(payload: CreateProductPayload) {
  const supplier = db.prepare<{ id: string }>("SELECT id FROM suppliers WHERE id = ? AND status = 'active'").get(payload.preferredSupplierId);
  if (!supplier) {
    throw new Error('Active supplier not found');
  }

  const duplicate = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM products WHERE sku = ?').get(
    payload.sku.trim()
  )?.count ?? 0;

  if (duplicate > 0) {
    throw new Error('SKU already exists');
  }

  const productId = nextEntityId('products', 'PRD');
  const inventoryId = nextEntityId('inventory', 'INV');
  const defaultWarehouse = db.prepare<{ id: string }>('SELECT id FROM warehouses ORDER BY id ASC LIMIT 1').get();

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO products (
        id, sku, name, category, unit, status, safe_stock, sale_price, cost_price, preferred_supplier_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      productId,
      payload.sku.trim(),
      payload.name.trim(),
      payload.category.trim(),
      payload.unit.trim(),
      'active',
      payload.safeStock,
      payload.salePrice,
      payload.costPrice,
      payload.preferredSupplierId
    );

    if (defaultWarehouse) {
      db.prepare(
        'INSERT INTO inventory (id, product_id, warehouse_id, current_stock, reserved_stock) VALUES (?, ?, ?, ?, ?)'
      ).run(inventoryId, productId, defaultWarehouse.id, 0, 0);
    }

    appendAuditLog('create_product', 'product', productId, {
      sku: payload.sku,
      supplierId: payload.preferredSupplierId,
    });
  });

  transaction();

  return getMasterDataOverview().products.find((item) => item.id === productId) as ProductRecord;
}

export function importProducts(rows: ImportSourceRow[]): ImportBatchResult {
  const errors: ImportRowError[] = [];
  const createdIds: string[] = [];
  let createdCount = 0;
  let skippedCount = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const sku = normalizeOptionalString(
      pickImportValue(row, ['SKU', 'sku', '商品编码', '商品编号', '货号', '编码'])
    ).toUpperCase();
    const name = normalizeOptionalString(
      pickImportValue(row, ['商品名称', '商品', '品名', '名称', 'name', 'productName', 'product'])
    );
    const category =
      normalizeOptionalString(pickImportValue(row, ['品类', '分类', '类目', 'category'])) || '日用百货';
    const unit = normalizeOptionalString(pickImportValue(row, ['单位', 'unit'])) || '件';
    const safeStock = parseNonNegativeInteger(
      pickImportValue(row, ['安全库存', 'safeStock', 'safestock', '最低库存', 'minStock']),
      30,
    );
    const salePrice = parsePositiveNumber(
      pickImportValue(row, ['售价', '销售价', '零售价', 'salePrice', 'price']),
    );
    const costPrice = parsePositiveNumber(
      pickImportValue(row, ['成本价', '采购价', '进价', 'costPrice', 'cost']),
    );
    const supplierRef = normalizeOptionalString(
      pickImportValue(row, [
        '默认供应商',
        '供应商',
        '供应商名称',
        'supplier',
        'supplierId',
        'supplierName',
        'preferredSupplier',
        'preferredSupplierId',
      ]),
    );

    if (!sku && !name && !supplierRef && !normalizeOptionalString(pickImportValue(row, ['售价', 'salePrice', 'price']))) {
      skippedCount += 1;
      return;
    }

    const missingFields = [
      !sku ? 'SKU' : '',
      !name ? '商品名称' : '',
      salePrice === null ? '售价' : '',
      costPrice === null ? '成本价' : '',
      !supplierRef ? '供应商' : '',
      safeStock === null ? '安全库存' : '',
    ].filter(Boolean);

    if (missingFields.length > 0) {
      errors.push({
        rowNumber,
        identifier: sku || name || `row-${rowNumber}`,
        reason: `缺少或无法解析字段：${missingFields.join('、')}`,
      });
      return;
    }

    const supplier = resolveActiveSupplierReference(supplierRef);
    if (!supplier) {
      errors.push({
        rowNumber,
        identifier: sku || name || `row-${rowNumber}`,
        reason: `未找到启用中的供应商：${supplierRef}`,
      });
      return;
    }

    try {
      const product = createProduct({
        sku,
        name,
        category,
        unit,
        safeStock: safeStock as number,
        salePrice: salePrice as number,
        costPrice: costPrice as number,
        preferredSupplierId: supplier.id,
      });
      createdCount += 1;
      createdIds.push(product.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Create product failed';
      if (reason === 'SKU already exists') {
        skippedCount += 1;
        return;
      }

      errors.push({
        rowNumber,
        identifier: sku || name || `row-${rowNumber}`,
        reason,
      });
    }
  });

  return {
    totalCount: rows.length,
    createdCount,
    skippedCount,
    errorCount: errors.length,
    createdIds,
    errors,
  };
}

export function updateProduct(productId: string, payload: UpdateProductPayload) {
  const product = db.prepare<{ id: string }>('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) {
    throw new Error('Product not found');
  }

  const supplier = db.prepare<{ id: string }>("SELECT id FROM suppliers WHERE id = ? AND status = 'active'").get(payload.preferredSupplierId);
  if (!supplier) {
    throw new Error('Active supplier not found');
  }

  const sku = payload.sku.trim();
  const name = payload.name.trim();
  const category = payload.category.trim();
  const unit = payload.unit.trim();

  if (!sku || !name || !category || !unit) {
    throw new Error('Product fields are required');
  }

  if (!Number.isInteger(payload.safeStock) || payload.safeStock < 0) {
    throw new Error('Safe stock must be a non-negative integer');
  }
  if (!Number.isFinite(payload.salePrice) || payload.salePrice <= 0) {
    throw new Error('Sale price must be a positive number');
  }
  if (!Number.isFinite(payload.costPrice) || payload.costPrice <= 0) {
    throw new Error('Cost price must be a positive number');
  }

  const duplicate = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM products WHERE sku = ? AND id <> ?'
  ).get(sku, productId)?.count ?? 0;

  if (duplicate > 0) {
    throw new Error('SKU already exists');
  }

  db.prepare(
    `UPDATE products
      SET sku = ?, name = ?, category = ?, unit = ?, safe_stock = ?, sale_price = ?, cost_price = ?, preferred_supplier_id = ?
      WHERE id = ?`
  ).run(sku, name, category, unit, payload.safeStock, payload.salePrice, payload.costPrice, payload.preferredSupplierId, productId);

  appendAuditLog('update_product', 'product', productId, {
    sku,
    name,
    preferredSupplierId: payload.preferredSupplierId,
  });

  return getMasterDataOverview().products.find((item) => item.id === productId) as ProductRecord;
}

export function toggleProductStatus(productId: string) {
  const product = db.prepare<{ status: 'active' | 'inactive' }>('SELECT status FROM products WHERE id = ?').get(productId);
  if (!product) {
    throw new Error('Product not found');
  }

  const nextStatus = product.status === 'active' ? 'inactive' : 'active';
  db.prepare('UPDATE products SET status = ? WHERE id = ?').run(nextStatus, productId);

  appendAuditLog('toggle_product_status', 'product', productId, {
    status: nextStatus,
  });

  return getMasterDataOverview().products.find((item) => item.id === productId) as ProductRecord;
}

export function deleteProduct(productId: string) {
  const product = db.prepare<{ id: string; sku: string; name: string; status: 'active' | 'inactive' }>(
    "SELECT id, sku, name, COALESCE(status, 'active') as status FROM products WHERE id = ?"
  ).get(productId);
  if (!product) {
    throw new Error('Product not found');
  }

  if (product.status !== 'inactive') {
    throw new Error('Product must be inactive before deletion');
  }

  if (!canDeleteProductRecord(productId, product.status)) {
    throw new Error('Product has business references or stock and cannot be deleted');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM inventory WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);

    appendAuditLog('delete_product', 'product', productId, {
      sku: product.sku,
      name: product.name,
    });
  });

  transaction();
}

export function createWarehouse(payload: CreateWarehousePayload) {
  const name = payload.name.trim();
  const locationCode = payload.locationCode.trim();

  if (!name) {
    throw new Error('Warehouse name is required');
  }

  if (!locationCode) {
    throw new Error('Warehouse location code is required');
  }

  if (!Number.isInteger(payload.capacity) || payload.capacity <= 0) {
    throw new Error('Warehouse capacity must be a positive integer');
  }

  const duplicateName = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM warehouses WHERE name = ?').get(name)?.count ?? 0;
  if (duplicateName > 0) {
    throw new Error('Warehouse name already exists');
  }

  const duplicateLocationCode =
    db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM warehouses WHERE location_code = ?').get(locationCode)?.count ?? 0;
  if (duplicateLocationCode > 0) {
    throw new Error('Warehouse location code already exists');
  }

  const warehouseId = nextEntityId('warehouses', 'WH');

  db.prepare('INSERT INTO warehouses (id, name, location_code, capacity) VALUES (?, ?, ?, ?)').run(
    warehouseId,
    name,
    locationCode,
    payload.capacity
  );

  appendAuditLog('create_warehouse', 'warehouse', warehouseId, {
    name,
    locationCode,
    capacity: payload.capacity,
  });

  return getMasterDataOverview().warehouses.find((item) => item.id === warehouseId) as WarehouseRecord;
}

export function updateWarehouse(warehouseId: string, payload: UpdateWarehousePayload) {
  const warehouse = db.prepare<{ id: string }>('SELECT id FROM warehouses WHERE id = ?').get(warehouseId);
  if (!warehouse) {
    throw new Error('Warehouse not found');
  }

  const name = payload.name.trim();
  const locationCode = payload.locationCode.trim();

  if (!name || !locationCode) {
    throw new Error('Warehouse fields are required');
  }

  if (!Number.isInteger(payload.capacity) || payload.capacity <= 0) {
    throw new Error('Warehouse capacity must be a positive integer');
  }

  const duplicateName = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM warehouses WHERE name = ? AND id <> ?'
  ).get(name, warehouseId)?.count ?? 0;
  if (duplicateName > 0) {
    throw new Error('Warehouse name already exists');
  }

  const duplicateLocationCode = db.prepare<{ count: number }>(
    'SELECT COUNT(*) as count FROM warehouses WHERE location_code = ? AND id <> ?'
  ).get(locationCode, warehouseId)?.count ?? 0;
  if (duplicateLocationCode > 0) {
    throw new Error('Warehouse location code already exists');
  }

  db.prepare('UPDATE warehouses SET name = ?, location_code = ?, capacity = ? WHERE id = ?').run(
    name,
    locationCode,
    payload.capacity,
    warehouseId
  );

  appendAuditLog('update_warehouse', 'warehouse', warehouseId, {
    name,
    locationCode,
    capacity: payload.capacity,
  });

  return getMasterDataOverview().warehouses.find((item) => item.id === warehouseId) as WarehouseRecord;
}

export function deleteWarehouse(warehouseId: string) {
  const warehouse = db.prepare<{ id: string; name: string }>('SELECT id, name FROM warehouses WHERE id = ?').get(warehouseId);
  if (!warehouse) {
    throw new Error('Warehouse not found');
  }

  if (!canDeleteWarehouseRecord(warehouseId)) {
    throw new Error('Warehouse still has stock or business references and cannot be deleted');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM inventory WHERE warehouse_id = ?').run(warehouseId);
    db.prepare('DELETE FROM warehouses WHERE id = ?').run(warehouseId);

    appendAuditLog('delete_warehouse', 'warehouse', warehouseId, {
      name: warehouse.name,
    });
  });

  transaction();
}


