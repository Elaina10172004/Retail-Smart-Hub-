import { Router } from 'express';
import { requirePermission } from '../../shared/auth';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { fail, ok } from '../../shared/response';
import {
  createOrder,
  deleteOrder,
  getOrderDetail,
  importOrders,
  listOrders,
  updateOrderStatus,
  type CreateOrderPayload,
  type ImportSourceRow,
  type OrderStatusUpdate,
} from './orders.service';

const ORDER_STATUS_COMPLETED: OrderStatusUpdate = '已完成';
const ORDER_STATUS_CANCELLED: OrderStatusUpdate = '已取消';

export const ordersRouter = Router();

ordersRouter.get('/summary', requirePermission('orders.view'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('orders'),
    summary: {
      existingUi: ['订单列表', '订单详情', '创建订单', '状态流转'],
      plannedEntities: ['sales_order', 'sales_order_item', 'customer', 'backorder'],
      nextMilestones: ['补订单更多筛选', '补订单协同通知', '补订单履约统计'],
    },
  });
});

ordersRouter.get('/', requirePermission('orders.view'), (_req, res) => {
  return ok(res, listOrders());
});

ordersRouter.get('/:id', requirePermission('orders.view'), (req, res) => {
  const order = getOrderDetail(req.params.id);
  if (!order) {
    return fail(res, 404, 'Order not found');
  }

  return ok(res, order);
});

ordersRouter.post('/', requirePermission('orders.create'), (req, res) => {
  const payload = req.body as Partial<CreateOrderPayload>;

  if (!payload.customerName?.trim()) {
    return fail(res, 400, 'customerName is required');
  }
  if (!payload.orderChannel?.trim()) {
    return fail(res, 400, 'orderChannel is required');
  }
  if (!payload.expectedDeliveryDate?.trim()) {
    return fail(res, 400, 'expectedDeliveryDate is required');
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return fail(res, 400, 'items must contain at least one line');
  }

  const invalidItem = payload.items.some((item) => {
    return (
      !item ||
      typeof item.sku !== 'string' ||
      !item.sku.trim() ||
      typeof item.productName !== 'string' ||
      !item.productName.trim() ||
      typeof item.quantity !== 'number' ||
      item.quantity <= 0 ||
      typeof item.unitPrice !== 'number' ||
      item.unitPrice <= 0
    );
  });

  if (invalidItem) {
    return fail(res, 400, 'each item must include sku, productName, quantity and unitPrice');
  }

  const order = createOrder(payload as CreateOrderPayload);
  return ok(res, order, '订单已创建。');
});

ordersRouter.post('/import', requirePermission('orders.create'), (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? (req.body.rows as ImportSourceRow[]) : null;
  if (!rows || rows.length === 0) {
    return fail(res, 400, 'rows must contain at least one record');
  }

  const result = importOrders(rows);
  return ok(res, result, '订单批量导入已处理。');
});

ordersRouter.post('/:id/status', requirePermission('orders.create'), (req, res) => {
  const status = (req.body as Partial<{ status: OrderStatusUpdate }>).status;
  if (status !== ORDER_STATUS_COMPLETED && status !== ORDER_STATUS_CANCELLED) {
    return fail(res, 400, 'status must be 已完成 or 已取消');
  }

  try {
    const order = updateOrderStatus(req.params.id, status);
    return ok(res, order, '订单状态已更新。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Update order status failed');
  }
});

ordersRouter.delete('/:id', requirePermission('orders.create'), (req, res) => {
  const aggressive = req.query.aggressive === '1' || req.query.aggressive === 'true';
  try {
    const result = deleteOrder(req.params.id, { aggressive });
    return ok(res, result, '订单已删除。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Delete order failed');
  }
});
