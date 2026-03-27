import { appendAuditLog, appendInventoryMovement, db, nextDocumentId } from '../../database/db';
import { currentDateString, currentDateTimeString } from '../../shared/format';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';
import { allocateOutboundFromShelves } from '../inventory/inventory-shelf.service';

export type ShippingStatus = '待发货' | '部分发货' | '已发货';
export type ShipmentStockStatus = '库存充足' | '待补货' | '-';

export interface ShippingRecord {
  id: string;
  orderId: string;
  orderIds: string[];
  orderCount: number;
  documentScope: '单订单' | '合并发货';
  customer: string;
  items: number;
  status: ShippingStatus;
  stockStatus: ShipmentStockStatus;
  courier: string;
  trackingNo: string;
  createdAt?: string;
}

export interface ShippingDetailRecord extends ShippingRecord {
  orderChannel: string;
  orderChannels: string[];
  shippedAt?: string;
  remark?: string;
  itemsDetail: Array<{
    orderId: string;
    sku: string;
    productName: string;
    quantity: number;
  }>;
}

export interface ShippingWorkbenchItem {
  orderItemId: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  shippedQty: number;
  reservedQty: number;
  remainingQty: number;
  suggestedShipQty: number;
}

export interface ShippingWorkbenchOrder {
  orderId: string;
  customer: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  status: ShippingStatus;
  stockStatus: ShipmentStockStatus;
  remainingQty: number;
  items: ShippingWorkbenchItem[];
}

export interface ShippingWorkbenchCustomer {
  customerName: string;
  totalOrders: number;
  totalPendingQty: number;
  orders: ShippingWorkbenchOrder[];
}

export interface CreateShipmentDocumentPayload {
  customerName: string;
  remark?: string;
  orders: Array<{
    orderId: string;
    items: Array<{
      orderItemId: string;
      quantity: number;
    }>;
  }>;
}

interface ShipmentDocumentRow {
  id: string;
  customer: string;
  createdAt: string;
  status: ShippingStatus;
  documentScope: '单订单' | '合并发货';
  courier: string | null;
  trackingNo: string | null;
  shippedAt: string | null;
  remark: string | null;
  orderRefs: string | null;
  orderChannels: string | null;
  orderCount: number;
  items: number;
}

interface WorkbenchItemRow {
  orderId: string;
  customer: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  status: ShippingStatus;
  stockStatus: ShipmentStockStatus;
  orderItemId: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  shippedQty: number;
  reservedQty: number;
}

interface ShipmentSelectionRow {
  orderId: string;
  customerName: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  orderItemId: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  shippedQty: number;
  reservedQty: number;
}

function inferCourier(orderChannels: string[]) {
  const normalized = Array.from(new Set(orderChannels.filter(Boolean)));
  if (normalized.length !== 1) {
    return '综合配送';
  }

  if (normalized[0] === '线上商城') {
    return '顺丰速运';
  }

  if (normalized[0] === '企业团购') {
    return '德邦物流';
  }

  return '门店配送';
}

function buildTrackingNumber(documentId: string) {
  return `TRK-${documentId.replaceAll('-', '')}`;
}

function ensureOrderDeliverySummary(orderId: string) {
  const existing = db.prepare<{ id: string }>('SELECT id FROM delivery_notes WHERE sales_order_id = ?').get(orderId);
  if (existing?.id) {
    return existing.id;
  }

  const order = db.prepare<{ orderDate: string }>('SELECT order_date as orderDate FROM sales_orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error(`Sales order not found: ${orderId}`);
  }

  const deliveryId = nextDocumentId('delivery_notes', 'SHP', order.orderDate);
  db.prepare(
    'INSERT INTO delivery_notes (id, sales_order_id, created_at, shipment_status, courier, tracking_no, shipped_at, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(deliveryId, orderId, currentDateTimeString(), '待发货', null, null, null, 'System shipping summary created automatically.');

  return deliveryId;
}

function computeOrderShippingStatus(orderId: string) {
  const rows = db.prepare<{
    productId: string;
    orderedQty: number;
    shippedQty: number;
    currentStock: number;
    reservedStock: number;
    reservedQty: number;
  }>(`
    SELECT
      soi.product_id as productId,
      soi.quantity as orderedQty,
      COALESCE(outbound.shippedQty, 0) as shippedQty,
      COALESCE(inv.current_stock, 0) as currentStock,
      COALESCE(inv.reserved_stock, 0) as reservedStock,
      COALESCE(sr.quantity, 0) as reservedQty
    FROM sales_order_items soi
    LEFT JOIN (
      SELECT sales_order_id, product_id, SUM(quantity) as shippedQty
      FROM stock_out_records
      WHERE sales_order_id = ?
      GROUP BY sales_order_id, product_id
    ) outbound ON outbound.sales_order_id = soi.sales_order_id AND outbound.product_id = soi.product_id
    LEFT JOIN inventory inv ON inv.product_id = soi.product_id AND inv.warehouse_id = ?
    LEFT JOIN stock_reservations sr ON sr.sales_order_id = soi.sales_order_id AND sr.product_id = soi.product_id AND sr.warehouse_id = ?
    WHERE soi.sales_order_id = ?
  `).all(orderId, DEFAULT_WAREHOUSE_ID, DEFAULT_WAREHOUSE_ID, orderId);

  const totalOrdered = rows.reduce((sum, row) => sum + row.orderedQty, 0);
  const totalShipped = rows.reduce((sum, row) => sum + Math.min(row.orderedQty, row.shippedQty), 0);

  let nextStatus: ShippingStatus = '待发货';
  if (totalShipped > 0 && totalShipped < totalOrdered) {
    nextStatus = '部分发货';
  } else if (totalShipped >= totalOrdered && totalOrdered > 0) {
    nextStatus = '已发货';
  }

  let stockStatus: ShipmentStockStatus = '-';
  if (nextStatus !== '已发货') {
    const canShipRemaining = rows
      .filter((row) => row.orderedQty - Math.min(row.orderedQty, row.shippedQty) > 0)
      .every((row) => {
        const remainingQty = row.orderedQty - Math.min(row.orderedQty, row.shippedQty);
        const available = Math.max(row.currentStock - row.reservedStock, 0);
        return remainingQty <= row.reservedQty + available;
      });
    stockStatus = canShipRemaining ? '库存充足' : '待补货';
  }

  return { nextStatus, stockStatus };
}

function syncOrderShippingSummary(
  orderId: string,
  shipmentDocumentId?: string,
  courier?: string,
  trackingNo?: string,
  shippedAt?: string,
) {
  const { nextStatus, stockStatus } = computeOrderShippingStatus(orderId);
  db.prepare('UPDATE sales_orders SET status = ?, stock_status = ? WHERE id = ?').run(nextStatus, stockStatus === '待补货' ? '部分缺货' : stockStatus, orderId);

  const deliverySummaryId = ensureOrderDeliverySummary(orderId);
  db.prepare(
    'UPDATE delivery_notes SET shipment_status = ?, courier = ?, tracking_no = ?, shipped_at = ?, remark = ? WHERE id = ?',
  ).run(
    nextStatus,
    nextStatus === '待发货' ? null : courier || null,
    nextStatus === '待发货' ? null : trackingNo || null,
    nextStatus === '待发货' ? null : shippedAt || null,
    nextStatus === '待发货' ? null : shipmentDocumentId ? `最近发货单 ${shipmentDocumentId}` : '最近已更新发货状态。',
    deliverySummaryId,
  );

  return { deliverySummaryId, nextStatus, stockStatus };
}

export function listShippingWorkbenchCustomers(): ShippingWorkbenchCustomer[] {
  const rows = db.prepare<WorkbenchItemRow>(`
    SELECT
      so.id as orderId,
      so.customer_name as customer,
      so.order_channel as orderChannel,
      so.expected_delivery_date as expectedDeliveryDate,
      so.status as status,
      CASE WHEN so.stock_status = '部分缺货' THEN '待补货' WHEN so.stock_status = '库存充足' THEN '库存充足' ELSE so.stock_status END as stockStatus,
      soi.id as orderItemId,
      soi.product_id as productId,
      soi.sku,
      soi.product_name as productName,
      soi.quantity as orderedQty,
      COALESCE(outbound.shippedQty, 0) as shippedQty,
      COALESCE(sr.quantity, 0) as reservedQty
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    LEFT JOIN (
      SELECT sales_order_id, product_id, SUM(quantity) as shippedQty
      FROM stock_out_records
      GROUP BY sales_order_id, product_id
    ) outbound ON outbound.sales_order_id = soi.sales_order_id AND outbound.product_id = soi.product_id
    LEFT JOIN stock_reservations sr ON sr.sales_order_id = soi.sales_order_id AND sr.product_id = soi.product_id AND sr.warehouse_id = ?
    WHERE so.status IN ('待发货', '部分发货')
    ORDER BY so.customer_name ASC, so.order_date ASC, so.id ASC, soi.id ASC
  `).all(DEFAULT_WAREHOUSE_ID);

  const customers = new Map<string, ShippingWorkbenchCustomer>();
  const orders = new Map<string, ShippingWorkbenchOrder>();

  rows.forEach((row) => {
    const remainingQty = Math.max(row.orderedQty - row.shippedQty, 0);
    if (remainingQty <= 0) {
      return;
    }

    const customer = customers.get(row.customer) || {
      customerName: row.customer,
      totalOrders: 0,
      totalPendingQty: 0,
      orders: [],
    };
    if (!customers.has(row.customer)) {
      customers.set(row.customer, customer);
    }

    const orderKey = `${row.customer}::${row.orderId}`;
    let order = orders.get(orderKey);
    if (!order) {
      order = {
        orderId: row.orderId,
        customer: row.customer,
        orderChannel: row.orderChannel,
        expectedDeliveryDate: row.expectedDeliveryDate,
        status: row.status,
        stockStatus: row.stockStatus,
        remainingQty: 0,
        items: [],
      };
      orders.set(orderKey, order);
      customer.orders.push(order);
      customer.totalOrders += 1;
    }

    order.items.push({
      orderItemId: row.orderItemId,
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      orderedQty: row.orderedQty,
      shippedQty: row.shippedQty,
      reservedQty: row.reservedQty,
      remainingQty,
      suggestedShipQty: Math.min(remainingQty, Math.max(row.reservedQty, 0)),
    });
    order.remainingQty += remainingQty;
    customer.totalPendingQty += remainingQty;
  });

  return Array.from(customers.values()).filter((customer) => customer.orders.length > 0);
}

function loadShipmentSelection(orderIds: string[]) {
  if (orderIds.length === 0) {
    return [] as ShipmentSelectionRow[];
  }

  const placeholders = orderIds.map(() => '?').join(', ');
  return db.prepare<ShipmentSelectionRow>(`
    SELECT
      so.id as orderId,
      so.customer_name as customerName,
      so.order_channel as orderChannel,
      so.expected_delivery_date as expectedDeliveryDate,
      soi.id as orderItemId,
      soi.product_id as productId,
      soi.sku,
      soi.product_name as productName,
      soi.quantity as orderedQty,
      COALESCE(outbound.shippedQty, 0) as shippedQty,
      COALESCE(sr.quantity, 0) as reservedQty
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    LEFT JOIN (
      SELECT sales_order_id, product_id, SUM(quantity) as shippedQty
      FROM stock_out_records
      GROUP BY sales_order_id, product_id
    ) outbound ON outbound.sales_order_id = soi.sales_order_id AND outbound.product_id = soi.product_id
    LEFT JOIN stock_reservations sr ON sr.sales_order_id = soi.sales_order_id AND sr.product_id = soi.product_id AND sr.warehouse_id = ?
    WHERE so.id IN (${placeholders})
    ORDER BY so.id ASC, soi.id ASC
  `).all(DEFAULT_WAREHOUSE_ID, ...orderIds);
}

export function createShipmentDocument(payload: CreateShipmentDocumentPayload): ShippingRecord {
  if (!payload.orders || payload.orders.length === 0) {
    throw new Error('Shipment orders are required');
  }

  const selectionRows = loadShipmentSelection(payload.orders.map((item) => item.orderId));
  const selectionMap = new Map(selectionRows.map((row) => [row.orderItemId, row]));
  const customers = new Set(selectionRows.map((row) => row.customerName));
  if (customers.size !== 1) {
    throw new Error('Consolidated dispatch requires all orders to belong to the same customer');
  }

  const customerName = selectionRows[0]?.customerName;
  if (!customerName) {
    throw new Error('Customer not found for shipment');
  }
  if (payload.customerName.trim() && payload.customerName.trim() !== customerName) {
    throw new Error('Shipment customer does not match selected orders');
  }

  const selectedItems = payload.orders.flatMap((order) =>
    order.items
      .filter((item) => item.quantity > 0)
      .map((item) => {
        const source = selectionMap.get(item.orderItemId);
        if (!source || source.orderId !== order.orderId) {
          throw new Error('Shipment item not found');
        }
        const remainingQty = Math.max(source.orderedQty - source.shippedQty, 0);
        if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > remainingQty) {
          throw new Error(`Invalid shipment quantity for ${source.sku}`);
        }
        return {
          ...source,
          shipQty: item.quantity,
          remainingQty,
        };
      }),
  );

  if (selectedItems.length === 0) {
    throw new Error('At least one shipment item is required');
  }

  const demandByProduct = new Map<string, number>();
  const reservationByProduct = new Map<string, number>();
  selectedItems.forEach((item) => {
    demandByProduct.set(item.productId, (demandByProduct.get(item.productId) || 0) + item.shipQty);
    reservationByProduct.set(item.productId, (reservationByProduct.get(item.productId) || 0) + Math.max(item.reservedQty, 0));
  });

  demandByProduct.forEach((demandQty, productId) => {
    const stock = db.prepare<{ currentStock: number; reservedStock: number }>(
      'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
    ).get(productId, DEFAULT_WAREHOUSE_ID);
    if (!stock) {
      throw new Error(`Inventory record missing for product ${productId}`);
    }
    const freeStock = Math.max(stock.currentStock - stock.reservedStock, 0);
    const availableToSelection = freeStock + (reservationByProduct.get(productId) || 0);
    if (demandQty > availableToSelection) {
      throw new Error(`Inventory is insufficient for product ${productId}`);
    }
  });

  const today = currentDateString();
  const now = currentDateTimeString();
  const shipmentDocumentId = nextDocumentId('shipment_documents', 'SHP', today);
  const orderIds = Array.from(new Set(selectedItems.map((item) => item.orderId)));
  const orderChannels = Array.from(new Set(selectedItems.map((item) => item.orderChannel)));
  const documentScope: ShippingRecord['documentScope'] = orderIds.length > 1 ? '合并发货' : '单订单';
  const courier = inferCourier(orderChannels);
  const trackingNo = buildTrackingNumber(shipmentDocumentId);

  const transaction = db.transaction(() => {
    db.prepare(
      'INSERT INTO shipment_documents (id, customer_name, created_at, shipment_status, document_scope, courier, tracking_no, shipped_at, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      shipmentDocumentId,
      customerName,
      now,
      '已发货',
      documentScope,
      courier,
      trackingNo,
      today,
      payload.remark?.trim() || null,
    );

    const insertOrderLink = db.prepare(
      'INSERT INTO shipment_document_orders (id, shipment_document_id, sales_order_id) VALUES (?, ?, ?)',
    );
    orderIds.forEach((orderId, index) => {
      insertOrderLink.run(`${shipmentDocumentId}-ORD-${index + 1}`, shipmentDocumentId, orderId);
    });

    const insertItem = db.prepare(
      'INSERT INTO shipment_document_items (id, shipment_document_id, sales_order_id, sales_order_item_id, product_id, sku, product_name, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const aggregateOutbound = new Map<string, number>();

    selectedItems.forEach((item, index) => {
      const stock = db.prepare<{ currentStock: number; reservedStock: number }>(
        'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
      ).get(item.productId, DEFAULT_WAREHOUSE_ID);
      if (!stock) {
        throw new Error(`Inventory record missing for product ${item.productId}`);
      }

      const reservation = db.prepare<{ quantity: number }>(
        'SELECT quantity FROM stock_reservations WHERE sales_order_id = ? AND product_id = ? AND warehouse_id = ?',
      ).get(item.orderId, item.productId, DEFAULT_WAREHOUSE_ID);
      const releaseQty = Math.min(reservation?.quantity ?? 0, item.shipQty);
      const qtyAfter = stock.currentStock - item.shipQty;
      const reservedAfter = stock.reservedStock - releaseQty;
      if (qtyAfter < 0 || reservedAfter < 0) {
        throw new Error(`Inventory inconsistency for ${item.sku}`);
      }

      db.prepare('UPDATE inventory SET current_stock = ?, reserved_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
        qtyAfter,
        reservedAfter,
        item.productId,
        DEFAULT_WAREHOUSE_ID,
      );

      if (reservation) {
        const remainingReservation = reservation.quantity - releaseQty;
        if (remainingReservation > 0) {
          db.prepare('UPDATE stock_reservations SET quantity = ?, updated_at = ? WHERE sales_order_id = ? AND product_id = ? AND warehouse_id = ?').run(
            remainingReservation,
            now,
            item.orderId,
            item.productId,
            DEFAULT_WAREHOUSE_ID,
          );
        } else {
          db.prepare('DELETE FROM stock_reservations WHERE sales_order_id = ? AND product_id = ? AND warehouse_id = ?').run(
            item.orderId,
            item.productId,
            DEFAULT_WAREHOUSE_ID,
          );
        }
      }

      insertItem.run(
        `${shipmentDocumentId}-ITEM-${index + 1}`,
        shipmentDocumentId,
        item.orderId,
        item.orderItemId,
        item.productId,
        item.sku,
        item.productName,
        item.shipQty,
      );

      const deliverySummaryId = ensureOrderDeliverySummary(item.orderId);
      db.prepare(
        'INSERT INTO stock_out_records (id, delivery_note_id, sales_order_id, product_id, warehouse_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        `${shipmentDocumentId}-OUT-${index + 1}`,
        deliverySummaryId,
        item.orderId,
        item.productId,
        DEFAULT_WAREHOUSE_ID,
        item.shipQty,
        today,
      );

      appendInventoryMovement({
        productId: item.productId,
        warehouseId: DEFAULT_WAREHOUSE_ID,
        movementType: 'outbound',
        sourceType: 'shipment_document',
        sourceId: shipmentDocumentId,
        qtyChange: -item.shipQty,
        reservedChange: -releaseQty,
        qtyBefore: stock.currentStock,
        qtyAfter,
        reservedBefore: stock.reservedStock,
        reservedAfter,
        occurredAt: now,
        remark: `发货出库 ${item.orderId}`,
      });

      aggregateOutbound.set(item.productId, (aggregateOutbound.get(item.productId) || 0) + item.shipQty);
    });

    aggregateOutbound.forEach((quantity, productId) => {
      allocateOutboundFromShelves(productId, DEFAULT_WAREHOUSE_ID, quantity);
    });

    orderIds.forEach((orderId) => {
      syncOrderShippingSummary(orderId, shipmentDocumentId, courier, trackingNo, today);
    });

    appendAuditLog('dispatch_shipment_document', 'shipment_document', shipmentDocumentId, {
      customerName,
      orderIds,
      itemCount: selectedItems.length,
      totalQuantity: selectedItems.reduce((sum, item) => sum + item.shipQty, 0),
      courier,
      trackingNo,
    });
  });

  transaction();
  return listShipmentDocuments().find((item) => item.id === shipmentDocumentId) as ShippingRecord;
}

function toShippingRecord(row: ShipmentDocumentRow): ShippingRecord {
  const orderIds = (row.orderRefs || '').split(',').filter(Boolean);
  return {
    id: row.id,
    orderId: orderIds.length === 1 ? orderIds[0] : `${orderIds.length} 张订单`,
    orderIds,
    orderCount: row.orderCount,
    documentScope: row.documentScope,
    customer: row.customer,
    items: row.items,
    status: row.status,
    stockStatus: '-',
    courier: row.courier ?? '-',
    trackingNo: row.trackingNo ?? '-',
    createdAt: row.createdAt,
  };
}

export function listShipmentDocuments(): ShippingRecord[] {
  const rows = db.prepare<ShipmentDocumentRow>(`
    SELECT
      sd.id,
      sd.customer_name as customer,
      sd.created_at as createdAt,
      sd.shipment_status as status,
      sd.document_scope as documentScope,
      sd.courier,
      sd.tracking_no as trackingNo,
      sd.shipped_at as shippedAt,
      sd.remark,
      GROUP_CONCAT(DISTINCT sdo.sales_order_id) as orderRefs,
      GROUP_CONCAT(DISTINCT so.order_channel) as orderChannels,
      COUNT(DISTINCT sdo.sales_order_id) as orderCount,
      COALESCE(SUM(sdi.quantity), 0) as items
    FROM shipment_documents sd
    LEFT JOIN shipment_document_orders sdo ON sdo.shipment_document_id = sd.id
    LEFT JOIN shipment_document_items sdi ON sdi.shipment_document_id = sd.id
    LEFT JOIN sales_orders so ON so.id = sdo.sales_order_id
    GROUP BY sd.id
    ORDER BY COALESCE(sd.shipped_at, sd.created_at) DESC, sd.id DESC
  `).all();

  const legacyRows = db.prepare<ShipmentDocumentRow>(`
    SELECT
      dn.id,
      so.customer_name as customer,
      dn.created_at as createdAt,
      dn.shipment_status as status,
      '单订单' as documentScope,
      dn.courier,
      dn.tracking_no as trackingNo,
      dn.shipped_at as shippedAt,
      dn.remark,
      so.id as orderRefs,
      so.order_channel as orderChannels,
      1 as orderCount,
      so.item_count as items
    FROM delivery_notes dn
    JOIN sales_orders so ON so.id = dn.sales_order_id
    WHERE dn.shipment_status = '已发货'
      AND NOT EXISTS (
        SELECT 1 FROM shipment_document_orders sdo WHERE sdo.sales_order_id = so.id
      )
    ORDER BY COALESCE(dn.shipped_at, dn.created_at) DESC, dn.id DESC
  `).all();

  return [...rows, ...legacyRows]
    .map(toShippingRecord)
    .sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || '') || right.id.localeCompare(left.id));
}

export function getShipmentDocumentDetail(shipmentDocumentId: string): ShippingDetailRecord | null {
  const row = db.prepare<ShipmentDocumentRow>(`
    SELECT
      sd.id,
      sd.customer_name as customer,
      sd.created_at as createdAt,
      sd.shipment_status as status,
      sd.document_scope as documentScope,
      sd.courier,
      sd.tracking_no as trackingNo,
      sd.shipped_at as shippedAt,
      sd.remark,
      GROUP_CONCAT(DISTINCT sdo.sales_order_id) as orderRefs,
      GROUP_CONCAT(DISTINCT so.order_channel) as orderChannels,
      COUNT(DISTINCT sdo.sales_order_id) as orderCount,
      COALESCE(SUM(sdi.quantity), 0) as items
    FROM shipment_documents sd
    LEFT JOIN shipment_document_orders sdo ON sdo.shipment_document_id = sd.id
    LEFT JOIN shipment_document_items sdi ON sdi.shipment_document_id = sd.id
    LEFT JOIN sales_orders so ON so.id = sdo.sales_order_id
    WHERE sd.id = ?
    GROUP BY sd.id
  `).get(shipmentDocumentId);

  if (!row) {
    return null;
  }

  const base = toShippingRecord(row);
  const items = db.prepare<{ orderId: string; sku: string; productName: string; quantity: number }>(`
    SELECT
      sales_order_id as orderId,
      sku,
      product_name as productName,
      quantity
    FROM shipment_document_items
    WHERE shipment_document_id = ?
    ORDER BY sales_order_id ASC, id ASC
  `).all(shipmentDocumentId);

  const orderChannels = (row.orderChannels || '').split(',').filter(Boolean);
  return {
    ...base,
    orderChannel: orderChannels.join(' / ') || '-',
    orderChannels,
    shippedAt: row.shippedAt ?? undefined,
    remark: row.remark ?? undefined,
    itemsDetail: items,
  };
}
