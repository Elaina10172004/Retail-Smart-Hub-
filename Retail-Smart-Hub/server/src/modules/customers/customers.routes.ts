import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import {
  createCustomer,
  deleteCustomer,
  getCustomerDetail,
  getCustomerSummary,
  importCustomers,
  listCustomers,
  toggleCustomerStatus,
  updateCustomer,
  type CreateCustomerPayload,
  type ImportSourceRow,
  type UpdateCustomerPayload,
} from './customers.service';

export const customersRouter = Router();

customersRouter.get('/summary', requirePermission('settings.master-data'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('customers'),
    summary: {
      existingUi: ['客户档案列表', '客户详情查看', '客户状态维护'],
      plannedEntities: ['customer', 'sales_order', 'receivable'],
      nextMilestones: ['补客户批量导入', '补客户分层规则', '补客户跟进记录'],
    },
  });
});

customersRouter.get('/overview', requirePermission('settings.master-data'), (_req, res) => {
  return ok(res, getCustomerSummary());
});

customersRouter.get('/', requirePermission('settings.master-data'), (_req, res) => {
  return ok(res, listCustomers());
});

customersRouter.get('/:id', requirePermission('settings.master-data'), (req, res) => {
  const customer = getCustomerDetail(req.params.id);
  if (!customer) {
    return fail(res, 404, 'Customer not found');
  }

  return ok(res, customer);
});

customersRouter.post('/', requirePermission('settings.master-data'), (req, res) => {
  const payload = req.body as Partial<CreateCustomerPayload>;

  if (!payload.name?.trim()) {
    return fail(res, 400, 'name is required');
  }
  if (!payload.channelPreference?.trim()) {
    return fail(res, 400, 'channelPreference is required');
  }

  try {
    const customer = createCustomer(payload as CreateCustomerPayload);
    return ok(res, customer, '客户档案已创建。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Create customer failed');
  }
});

customersRouter.post('/import', requirePermission('settings.master-data'), (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? (req.body.rows as ImportSourceRow[]) : null;
  if (!rows) {
    return fail(res, 400, 'rows must be an array');
  }

  try {
    const result = importCustomers(rows);
    return ok(res, result, `客户导入完成：新增 ${result.createdCount} 条，跳过 ${result.skippedCount} 条，失败 ${result.errorCount} 条。`);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Import customers failed');
  }
});

customersRouter.put('/:id', requirePermission('settings.master-data'), (req, res) => {
  const payload = req.body as Partial<UpdateCustomerPayload>;

  if (!payload.name?.trim()) {
    return fail(res, 400, 'name is required');
  }
  if (!payload.channelPreference?.trim()) {
    return fail(res, 400, 'channelPreference is required');
  }

  try {
    const customer = updateCustomer(req.params.id, payload as UpdateCustomerPayload);
    return ok(res, customer, '客户档案已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Update customer failed');
  }
});

customersRouter.post('/:id/toggle-status', requirePermission('settings.master-data'), (req, res) => {
  try {
    const customer = toggleCustomerStatus(req.params.id);
    return ok(res, customer, `客户已${customer.status === 'active' ? '启用' : '停用'}。`);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Toggle customer status failed');
  }
});

customersRouter.delete('/:id', requirePermission('settings.master-data'), (req, res) => {
  try {
    deleteCustomer(req.params.id);
    return ok(res, true, '客户档案已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete customer failed');
  }
});
