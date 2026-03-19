import { Router } from 'express';
import { requirePermission } from '../../shared/auth';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { fail, ok } from '../../shared/response';
import {
  deleteProcurementOrder,
  generateSuggestedPurchaseOrders,
  getProcurementOrderDetail,
  getProcurementSuggestions,
  listProcurementOrders,
  updateProcurementOrderStatus,
} from './procurement.service';

export const procurementRouter = Router();

procurementRouter.get('/summary', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('procurement'),
    summary: {
      existingUi: ['采购看板', '采购单列表', '采购建议入口'],
      plannedEntities: ['purchase_order', 'purchase_order_item', 'supplier', 'receiving_note'],
      nextMilestones: ['补采购详情接口', '补采购审核流程', '补供应商对账'],
    },
  });
});

procurementRouter.get('/suggestions', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, getProcurementSuggestions());
});

procurementRouter.get('/', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, listProcurementOrders());
});

procurementRouter.get('/:id', requirePermission('procurement.manage'), (req, res) => {
  const detail = getProcurementOrderDetail(req.params.id);
  if (!detail) {
    return fail(res, 404, 'Procurement order not found');
  }

  return ok(res, detail);
});

procurementRouter.post('/generate-shortage-orders', requirePermission('procurement.manage'), (_req, res) => {
  const created = generateSuggestedPurchaseOrders();
  if (created.length === 0) {
    return ok(res, created, '当前没有需要自动补货的采购单。');
  }

  return ok(res, created, `已生成 ${created.length} 张建议采购单。`);
});

procurementRouter.post('/:id/status', requirePermission('procurement.manage'), (req, res) => {
  const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
  if (!status) {
    return fail(res, 400, 'status is required');
  }

  try {
    const detail = updateProcurementOrderStatus(req.params.id, status);
    return ok(res, detail, '采购单状态已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Update procurement status failed');
  }
});

procurementRouter.delete('/:id', requirePermission('procurement.manage'), (req, res) => {
  const aggressive = req.query.aggressive === '1' || req.query.aggressive === 'true';
  try {
    const result = deleteProcurementOrder(req.params.id, { aggressive });
    return ok(res, result, '采购单已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete procurement order failed');
  }
});
