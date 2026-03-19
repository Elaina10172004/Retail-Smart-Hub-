import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission, resetUserPassword, verifyCurrentPassword } from '../../shared/auth';
import { isApiError } from '../../shared/api-error';
import { fail, ok } from '../../shared/response';
import { parseWithSchema } from '../../shared/validation';
import {
  createProduct,
  createRole,
  createSupplier,
  createUser,
  createWarehouse,
  deleteRole,
  deleteUser,
  deleteProduct,
  deleteSupplier,
  deleteWarehouse,
  getAccessOverview,
  getMasterDataOverview,
  importProducts,
  type ImportSourceRow,
  toggleProductStatus,
  toggleSupplierStatus,
  toggleUserStatus,
  updateProduct,
  updateRolePermissions,
  updateSupplier,
  updateUserRole,
  updateWarehouse,
  type CreateProductPayload,
  type CreateRolePayload,
  type CreateSupplierPayload,
  type CreateUserPayload,
  type CreateWarehousePayload,
  type UpdateProductPayload,
  type UpdateRolePermissionsPayload,
  type UpdateSupplierPayload,
  type UpdateUserRolePayload,
  type UpdateWarehousePayload,
} from './settings.service';
import {
  createProductSchema,
  createRoleSchema,
  createSupplierSchema,
  createUserSchema,
  createWarehouseSchema,
  importProductsSchema,
  resetUserPasswordSchema,
  sensitiveVerifySchema,
  updateProductSchema,
  updateRolePermissionsSchema,
  updateSupplierSchema,
  updateUserRoleSchema,
  updateWarehouseSchema,
} from './settings.validators';

export const settingsRouter = Router();

function verifySensitiveRequest(req: { body?: unknown; auth?: { id: string } }, res: Parameters<typeof fail>[0]) {
  try {
    const payload = parseWithSchema(sensitiveVerifySchema, req.body, 'verify-sensitive-request');
    verifyCurrentPassword(req.auth?.id || '', payload.verifyPassword);
    return true;
  } catch (error) {
    fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Sensitive operation verification failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
    return false;
  }
}

settingsRouter.get('/summary', (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('settings'),
    summary: {
      existingUi: ['系统设置页面', '用户角色展示', '基础资料展示', '审计日志查询'],
      plannedEntities: ['user', 'role', 'permission', 'supplier', 'product', 'warehouse'],
      nextMilestones: ['补复杂授权模板', '补仓库档案维护', '补用户安全策略'],
    },
  });
});

settingsRouter.get('/access', requirePermission('settings.access-control'), (_req, res) => {
  return ok(res, getAccessOverview());
});

settingsRouter.get('/master-data', requirePermission('settings.master-data'), (_req, res) => {
  return ok(res, getMasterDataOverview());
});

settingsRouter.post('/users', requirePermission('settings.access-control'), (req, res) => {
  try {
    const payload = parseWithSchema(createUserSchema, req.body, 'settings-create-user');
    const result = createUser(payload as CreateUserPayload);
    return ok(res, result, '用户已创建，并已生成一次性临时口令。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Create user failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/users/:id/toggle-status', requirePermission('settings.access-control'), (req, res) => {
  try {
    const user = toggleUserStatus(req.params.id);
    return ok(res, user, '用户状态已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Toggle user status failed');
  }
});

settingsRouter.post('/users/:id/reset-password', requirePermission('settings.access-control'), (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }

  try {
    const payload = parseWithSchema(resetUserPasswordSchema, req.body, 'settings-reset-user-password');
    resetUserPassword(req.params.id, payload.newPassword, req.auth?.id || '');
    return ok(res, true, '用户密码已重置。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Reset user password failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/users/:id/delete', requirePermission('settings.access-control'), (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }
  try {
    deleteUser(req.params.id, req.auth?.id || '');
    return ok(res, true, '用户已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete user failed');
  }
});

settingsRouter.post('/users/:id/role', requirePermission('settings.access-control'), (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }

  try {
    const payload = parseWithSchema(updateUserRoleSchema, req.body, 'settings-update-user-role');
    const user = updateUserRole(req.params.id, {
      roleId: payload.roleId,
    });
    return ok(res, user, '用户角色已更新。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Update user role failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/roles', requirePermission('settings.access-control'), (req, res) => {
  try {
    const payload = parseWithSchema(createRoleSchema, req.body, 'settings-create-role');
    const role = createRole({
      name: payload.name,
      description: payload.description,
      scope: payload.scope,
      templateRoleId: payload.templateRoleId,
    });
    return ok(res, role, '角色已创建。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Create role failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/roles/:id/delete', requirePermission('settings.access-control'), (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }
  try {
    deleteRole(req.params.id);
    return ok(res, true, '角色已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete role failed');
  }
});

settingsRouter.post('/roles/:id/permissions', requirePermission('settings.access-control'), (req, res) => {
  if (!verifySensitiveRequest(req, res)) {
    return;
  }

  try {
    const payload = parseWithSchema(updateRolePermissionsSchema, req.body, 'settings-role-permissions');
    const role = updateRolePermissions(req.params.id, {
      permissionCodes: payload.permissionCodes,
    });
    return ok(res, role, '角色权限已更新。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Update role permissions failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/suppliers', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(createSupplierSchema, req.body, 'settings-create-supplier');
    const supplier = createSupplier({
      name: payload.name,
      contactName: payload.contactName,
      phone: payload.phone,
      leadTimeDays: payload.leadTimeDays,
    });
    return ok(res, supplier, '供应商已创建。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Create supplier failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/suppliers/:id', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(updateSupplierSchema, req.body, 'settings-update-supplier');
    const supplier = updateSupplier(req.params.id, {
      name: payload.name,
      contactName: payload.contactName,
      phone: payload.phone,
      leadTimeDays: payload.leadTimeDays,
    });
    return ok(res, supplier, '供应商已更新。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Update supplier failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/suppliers/:id/toggle-status', requirePermission('settings.master-data'), (req, res) => {
  try {
    const supplier = toggleSupplierStatus(req.params.id);
    return ok(res, supplier, '供应商状态已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Toggle supplier status failed');
  }
});

settingsRouter.post('/suppliers/:id/delete', requirePermission('settings.master-data'), (req, res) => {
  try {
    deleteSupplier(req.params.id);
    return ok(res, true, '供应商已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete supplier failed');
  }
});

settingsRouter.post('/warehouses', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(createWarehouseSchema, req.body, 'settings-create-warehouse');
    const warehouse = createWarehouse({
      name: payload.name,
      locationCode: payload.locationCode,
      capacity: payload.capacity,
    });
    return ok(res, warehouse, '仓库已创建。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Create warehouse failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/warehouses/:id', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(updateWarehouseSchema, req.body, 'settings-update-warehouse');
    const warehouse = updateWarehouse(req.params.id, {
      name: payload.name,
      locationCode: payload.locationCode,
      capacity: payload.capacity,
    });
    return ok(res, warehouse, '仓库已更新。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Update warehouse failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/warehouses/:id/delete', requirePermission('settings.master-data'), (req, res) => {
  try {
    deleteWarehouse(req.params.id);
    return ok(res, true, '仓库已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete warehouse failed');
  }
});

settingsRouter.post('/products', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(createProductSchema, req.body, 'settings-create-product');
    const product = createProduct({
      sku: payload.sku,
      name: payload.name,
      category: payload.category,
      unit: payload.unit,
      safeStock: payload.safeStock,
      salePrice: payload.salePrice,
      costPrice: payload.costPrice,
      preferredSupplierId: payload.preferredSupplierId,
    });
    return ok(res, product, '商品已创建。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Create product failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/products/import', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(importProductsSchema, req.body, 'settings-import-products');
    const rows = payload.rows as ImportSourceRow[];
    const result = importProducts(rows);
    return ok(res, result, `商品导入完成：新增 ${result.createdCount} 条，跳过 ${result.skippedCount} 条，失败 ${result.errorCount} 条。`);
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Import products failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/products/:id', requirePermission('settings.master-data'), (req, res) => {
  try {
    const payload = parseWithSchema(updateProductSchema, req.body, 'settings-update-product');
    const product = updateProduct(req.params.id, {
      sku: payload.sku,
      name: payload.name,
      category: payload.category,
      unit: payload.unit,
      safeStock: payload.safeStock,
      salePrice: payload.salePrice,
      costPrice: payload.costPrice,
      preferredSupplierId: payload.preferredSupplierId,
    });
    return ok(res, product, '商品已更新。');
  } catch (error) {
    return fail(
      res,
      isApiError(error) ? error.status : 400,
      error instanceof Error ? error.message : 'Update product failed',
      isApiError(error) ? error.code : undefined,
      isApiError(error) ? error.details : undefined,
    );
  }
});

settingsRouter.post('/products/:id/toggle-status', requirePermission('settings.master-data'), (req, res) => {
  try {
    const product = toggleProductStatus(req.params.id);
    return ok(res, product, '商品状态已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Toggle product status failed');
  }
});

settingsRouter.post('/products/:id/delete', requirePermission('settings.master-data'), (req, res) => {
  try {
    deleteProduct(req.params.id);
    return ok(res, true, '商品已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete product failed');
  }
});

