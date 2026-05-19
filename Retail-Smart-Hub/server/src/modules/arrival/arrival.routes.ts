import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission, requireSuperAdmin } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import { paginateList } from '../../shared/paginate';
import {
  advanceArrival,
  createManualArrivalRecords,
  forceUpdateArrivalLines,
  getArrivalDetail,
  listArrivals,
  listManualArrivalCandidateItems,
} from './arrival.service';

export const arrivalRouter = Router();

arrivalRouter.get('/summary', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('arrival'),
    summary: {
      existingUi: ['到货验收列表', '到货状态按钮', '收货流程展示'],
      plannedEntities: ['receiving_note', 'receiving_note_item', 'quality_exception'],
      nextMilestones: ['补异常登记', '补差异对账', '补供应商到货绩效'],
    },
  });
});

arrivalRouter.get('/', requirePermission('procurement.manage'), (req, res) => {
  return ok(res, paginateList(req, () => listArrivals(), {
    searchFields: ['id', 'poId', 'supplier'],
    filters: [
      { queryKey: 'supplier', field: 'supplier' },
      { queryKey: 'status', field: 'status' },
    ],
    rangeFilters: [
      { minKey: 'arrivedAtFrom', maxKey: 'arrivedAtTo', field: 'arrivedAt', type: 'date' },
      { minKey: 'arrivedQtyMin', maxKey: 'arrivedQtyMax', field: 'arrivedQty', type: 'number' },
      { minKey: 'expectedQtyMin', maxKey: 'expectedQtyMax', field: 'expectedQty', type: 'number' },
    ],
  }));
});

arrivalRouter.get('/create-options', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, listManualArrivalCandidateItems());
});

arrivalRouter.post('/', requirePermission('procurement.manage'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    const result = createManualArrivalRecords(items);
    return ok(res, result, `已创建 ${result.arrivalIds.length} 张验收单。`);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Create manual arrival records failed');
  }
});

arrivalRouter.post('/:id/lines/force', requirePermission('procurement.manage'), requireSuperAdmin, (req, res) => {
  try {
    const detail = forceUpdateArrivalLines(req.params.id, req.body);
    return ok(res, detail, '验收单明细已强制修正。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Force update arrival lines failed');
  }
});

arrivalRouter.get('/:id', requirePermission('procurement.manage'), (req, res) => {
  const detail = getArrivalDetail(req.params.id);
  if (!detail) {
    return fail(res, 404, 'Arrival record not found');
  }

  return ok(res, detail);
});

arrivalRouter.post('/:id/advance', requirePermission('procurement.manage'), (req, res) => {
  try {
    const arrival = advanceArrival(req.params.id);
    return ok(res, arrival, '到货记录已推进到下一处理状态。');
  } catch (error) {
    return fail(res, 404, error instanceof Error ? error.message : 'Arrival record not found');
  }
});
