import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import { advanceArrival, getArrivalDetail, listArrivals } from './arrival.service';

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

arrivalRouter.get('/', requirePermission('procurement.manage'), (_req, res) => {
  return ok(res, listArrivals());
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
