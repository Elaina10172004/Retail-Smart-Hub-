import { Router } from 'express';
import { requirePermission } from '../../shared/auth';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { fail, ok } from '../../shared/response';
import {
  adjustInventory,
  forceDeleteInventory,
  getInventoryAlerts,
  getInventoryDetail,
  getInventoryOverview,
  listInventory,
  type InventoryAdjustmentPayload,
} from './inventory.service';

export const inventoryRouter = Router();

inventoryRouter.get('/summary', requirePermission('inventory.view'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('inventory'),
    summary: {
      existingUi: ['库存台账页面', '预警展示', '库存概览卡片'],
      plannedEntities: ['inventory', 'product', 'warehouse', 'stock_change_log'],
      nextMilestones: ['补盘点接口', '补库存调整接口', '补多仓库支持'],
    },
  });
});

inventoryRouter.get('/overview', requirePermission('inventory.view'), (_req, res) => {
  return ok(res, getInventoryOverview());
});

inventoryRouter.get('/alerts', requirePermission('inventory.view'), (_req, res) => {
  return ok(res, getInventoryAlerts());
});

inventoryRouter.get('/', requirePermission('inventory.view'), (_req, res) => {
  return ok(res, listInventory());
});

inventoryRouter.get('/:sku', requirePermission('inventory.view'), (req, res) => {
  const detail = getInventoryDetail(req.params.sku || '');
  if (!detail) {
    return fail(res, 404, 'Inventory item not found');
  }

  return ok(res, detail);
});

inventoryRouter.post('/adjust', requirePermission('inventory.write'), (req, res) => {
  const payload = req.body as Partial<InventoryAdjustmentPayload>;
  if (!payload.sku?.trim()) {
    return fail(res, 400, 'sku is required');
  }
  if (typeof payload.targetStock !== 'number') {
    return fail(res, 400, 'targetStock is required');
  }

  try {
    const item = adjustInventory(payload as InventoryAdjustmentPayload);
    return ok(res, item, '库存盘点结果已写入。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Adjust inventory failed');
  }
});

inventoryRouter.delete('/:sku', requirePermission('inventory.write'), (req, res) => {
  const aggressive = req.query.aggressive === '1' || req.query.aggressive === 'true';
  try {
    const result = forceDeleteInventory(req.params.sku || '', { aggressive });
    return ok(res, result, '库存记录已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete inventory failed');
  }
});
