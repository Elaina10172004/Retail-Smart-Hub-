import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import { dispatchShipment, getShipmentDetail, listShipments } from './shipping.service';

export const shippingRouter = Router();

shippingRouter.get('/summary', requirePermission('shipping.dispatch'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('shipping'),
    summary: {
      existingUi: ['发货页面', '待发货订单列表', '发货状态按钮'],
      plannedEntities: ['delivery_note', 'stock_out_record', 'sales_order'],
      nextMilestones: ['补批量发货', '补物流轨迹查询', '补发货撤销流程'],
    },
  });
});

shippingRouter.get('/', requirePermission('shipping.dispatch'), (_req, res) => {
  return ok(res, listShipments());
});

shippingRouter.get('/:id', requirePermission('shipping.dispatch'), (req, res) => {
  const detail = getShipmentDetail(req.params.id);
  if (!detail) {
    return fail(res, 404, 'Shipment not found');
  }

  return ok(res, detail);
});

shippingRouter.post('/:id/dispatch', requirePermission('shipping.dispatch'), (req, res) => {
  try {
    const shipment = dispatchShipment(req.params.id);
    return ok(res, shipment, '发货已确认，库存已同步扣减。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Dispatch failed');
  }
});
