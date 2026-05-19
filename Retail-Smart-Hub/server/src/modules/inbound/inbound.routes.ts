import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission, requireSuperAdmin } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import { paginateList } from '../../shared/paginate';
import {
  confirmInbound,
  createManualInboundOrders,
  deleteInbound,
  forceUpdateInboundLines,
  forceUpdateInboundStatus,
  getInboundDetail,
  listManualInboundCandidateItems,
  listInbounds,
  saveInboundDraft,
  type SaveInboundDraftItemPayload,
} from './inbound.service';

export const inboundRouter = Router();

inboundRouter.get('/summary', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('inbound'),
    summary: {
      existingUi: ['入库单列表', '确认入库按钮', '入库流程展示'],
      plannedEntities: ['inbound_order', 'inventory_change_log', 'warehouse_slot'],
      nextMilestones: ['补库位推荐', '补批量入库', '补入库撤销'],
    },
  });
});

inboundRouter.get('/', requirePermission('procurement.manage'), (req, res) => {
  return ok(res, paginateList(req, () => listInbounds(), {
    searchFields: ['id', 'rcvId', 'supplier', 'warehouse'],
    filters: [
      { queryKey: 'supplier', field: 'supplier' },
      { queryKey: 'warehouse', field: 'warehouse' },
      { queryKey: 'status', field: 'status' },
    ],
    rangeFilters: [
      { minKey: 'itemQtyMin', maxKey: 'itemQtyMax', field: 'items', type: 'number' },
    ],
  }));
});

inboundRouter.get('/create-options', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, listManualInboundCandidateItems());
});

inboundRouter.post('/', requirePermission('procurement.manage'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    const result = createManualInboundOrders(items);
    return ok(res, result, `已创建 ${result.inboundIds.length} 张入库单，并推进对应到货状态。`);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Create manual inbound orders failed');
  }
});

inboundRouter.get('/:id', requirePermission('procurement.manage'), (req, res) => {
  const detail = getInboundDetail(req.params.id);
  if (!detail) {
    return fail(res, 404, 'Inbound order not found');
  }

  return ok(res, detail);
});

inboundRouter.post('/:id/draft', requirePermission('procurement.manage'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? (req.body.items as SaveInboundDraftItemPayload[]) : [];
  if (items.length === 0) {
    return fail(res, 400, 'items are required');
  }

  try {
    const inbound = saveInboundDraft(req.params.id, items);
    return ok(res, inbound, '入库单草稿已保存。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Save inbound draft failed');
  }
});

inboundRouter.post('/:id/lines/force', requirePermission('procurement.manage'), requireSuperAdmin, (req, res) => {
  try {
    const inbound = forceUpdateInboundLines(req.params.id, req.body);
    return ok(res, inbound, '入库单明细已强制修正。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Force update inbound lines failed');
  }
});

inboundRouter.post('/:id/confirm', requirePermission('procurement.manage'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? (req.body.items as SaveInboundDraftItemPayload[]) : undefined;
  try {
    const inbound = confirmInbound(req.params.id, items);
    return ok(res, inbound, '入库已确认，库存已同步更新。');
  } catch (error) {
    return fail(res, 404, error instanceof Error ? error.message : 'Inbound order not found');
  }
});

inboundRouter.post('/:id/status', requirePermission('procurement.manage'), (req, res) => {
  const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
  if (!status) {
    return fail(res, 400, 'status is required');
  }

  try {
    const inbound = forceUpdateInboundStatus(req.params.id, status);
    return ok(res, inbound, '入库单状态已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Update inbound status failed');
  }
});

inboundRouter.delete('/:id', requirePermission('procurement.manage'), (req, res) => {
  const aggressive = req.query.aggressive === '1' || req.query.aggressive === 'true';
  try {
    const result = deleteInbound(req.params.id, { aggressive });
    return ok(res, result, '入库单已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete inbound order failed');
  }
});
