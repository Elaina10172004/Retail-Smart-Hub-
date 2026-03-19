import { appendAuditLog, appendInventoryMovement, db } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';

export type ShippingStatus = '待发货' | '已发货';
export type ShipmentStockStatus = '库存充足' | '待补货' | '-';

export interface ShippingRecord {
  id: string;
  orderId: string;
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
  createdAt: string;
  shippedAt?: string;
  remark?: string;
  itemsDetail: Array<{
    sku: string;
    productName: string;
    quantity: number;
  }>;
}

interface ShipmentRow {
  id: string;
  orderId: string;
  customer: string;
  items: number;
  status: ShippingStatus;
  courier: string | null;
  trackingNo: string | null;
  orderChannel: string;
  createdAt: string;
  shippedAt: string | null;
  remark: string | null;
}

interface OrderItemStockRow {
  productId: string;
  quantity: number;
  currentStock: number;
  reservedStock: number;
  reservedQty: number;
}

function inferCourier(orderChannel: string) {
  if (orderChannel === '线上商城') {
    return '顺丰速运';
  }

  if (orderChannel === '企业团购') {
    return '德邦物流';
  }

  return '门店配送';
}

function buildTrackingNumber(deliveryId: string) {
  return `TRK-${deliveryId.replaceAll('-', '')}`;
}

function loadShipmentRows() {
  return db.prepare<ShipmentRow>(`
    SELECT
      dn.id,
      so.id as orderId,
      so.customer_name as customer,
      so.item_count as items,
      dn.shipment_status as status,
      dn.courier,
      dn.tracking_no as trackingNo,
      so.order_channel as orderChannel,
      dn.created_at as createdAt,
      dn.shipped_at as shippedAt,
      dn.remark
    FROM delivery_notes dn
    JOIN sales_orders so ON so.id = dn.sales_order_id
    ORDER BY dn.created_at DESC, dn.id DESC
  `).all();
}

function loadShipment(id: string) {
  return db.prepare<ShipmentRow>(`
    SELECT
      dn.id,
      so.id as orderId,
      so.customer_name as customer,
      so.item_count as items,
      dn.shipment_status as status,
      dn.courier,
      dn.tracking_no as trackingNo,
      so.order_channel as orderChannel,
      dn.created_at as createdAt,
      dn.shipped_at as shippedAt,
      dn.remark
    FROM delivery_notes dn
    JOIN sales_orders so ON so.id = dn.sales_order_id
    WHERE dn.id = ?
  `).get(id);
}

function loadOrderItemStocks(orderId: string) {
  return db.prepare<OrderItemStockRow>(`
    SELECT
      soi.product_id as productId,
      soi.quantity,
      COALESCE(inv.current_stock, 0) as currentStock,
      COALESCE(inv.reserved_stock, 0) as reservedStock,
      COALESCE(sr.quantity, 0) as reservedQty
    FROM sales_order_items soi
    LEFT JOIN inventory inv ON inv.product_id = soi.product_id AND inv.warehouse_id = ?
    LEFT JOIN stock_reservations sr
      ON sr.sales_order_id = soi.sales_order_id
      AND sr.product_id = soi.product_id
      AND sr.warehouse_id = ?
    WHERE soi.sales_order_id = ?
    ORDER BY soi.id ASC
  `).all(DEFAULT_WAREHOUSE_ID, DEFAULT_WAREHOUSE_ID, orderId);
}

function computeStockStatus(orderId: string, shipmentStatus: ShippingStatus): ShipmentStockStatus {
  if (shipmentStatus === '已发货') {
    return '-';
  }

  const itemStocks = loadOrderItemStocks(orderId);
  const canShip = itemStocks.every((item) => {
    if (!item.productId) {
      return false;
    }
    if (item.reservedQty >= item.quantity) {
      return true;
    }
    const available = item.currentStock - item.reservedStock;
    return available >= item.quantity;
  });
  return canShip ? '库存充足' : '待补货';
}

function toShippingRecord(row: ShipmentRow): ShippingRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    customer: row.customer,
    items: row.items,
    status: row.status,
    stockStatus: computeStockStatus(row.orderId, row.status),
    courier: row.courier ?? '-',
    trackingNo: row.trackingNo ?? '-',
    createdAt: row.createdAt,
  };
}

export function listShipments() {
  return loadShipmentRows().map(toShippingRecord);
}

export function getShipmentDetail(deliveryId: string): ShippingDetailRecord | null {
  const shipment = loadShipment(deliveryId);
  if (!shipment) {
    return null;
  }

  const items = db.prepare<{ sku: string; productName: string; quantity: number }>(`
    SELECT
      sku,
      product_name as productName,
      quantity
    FROM sales_order_items
    WHERE sales_order_id = ?
    ORDER BY id ASC
  `).all(shipment.orderId);

  const record = toShippingRecord(shipment);
  return {
    ...record,
    orderChannel: shipment.orderChannel,
    createdAt: shipment.createdAt,
    shippedAt: shipment.shippedAt ?? undefined,
    remark: shipment.remark ?? undefined,
    itemsDetail: items,
  };
}

export function dispatchShipment(deliveryId: string) {
  const shipment = loadShipment(deliveryId);
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.status === '已发货') {
    throw new Error('Shipment already dispatched');
  }

  const itemStocks = loadOrderItemStocks(shipment.orderId);
  const insufficientItem = itemStocks.find((item) => {
    if (!item.productId) {
      return true;
    }
    if (item.reservedQty >= item.quantity) {
      return false;
    }
    const available = item.currentStock - item.reservedStock;
    return available < item.quantity;
  });
  if (insufficientItem) {
    throw new Error('Inventory or reservation is insufficient for dispatch');
  }

  const shippedAtDate = currentDateString();
  const movementOccurredAt = new Date().toISOString();
  const courier = inferCourier(shipment.orderChannel);
  const trackingNo = buildTrackingNumber(deliveryId);

  const transaction = db.transaction(() => {
    const insertStockOut = db.prepare(
      'INSERT INTO stock_out_records (id, delivery_note_id, sales_order_id, product_id, warehouse_id, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    itemStocks.forEach((item, index) => {
      const stock = db.prepare<{ currentStock: number; reservedStock: number }>(
        'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
      ).get(item.productId, DEFAULT_WAREHOUSE_ID);
      if (!stock) {
        throw new Error(`Inventory record missing for product ${item.productId}`);
      }

      const releaseQty = Math.min(item.reservedQty, item.quantity);
      if (stock.reservedStock < releaseQty) {
        throw new Error(`Reservation inconsistency for dispatch: product ${item.productId}`);
      }

      const qtyAfter = stock.currentStock - item.quantity;
      if (qtyAfter < 0) {
        throw new Error(`Inventory inconsistency for dispatch: product ${item.productId}`);
      }
      const reservedAfter = stock.reservedStock - releaseQty;

      db.prepare(
        'UPDATE inventory SET current_stock = ?, reserved_stock = ? WHERE product_id = ? AND warehouse_id = ?'
      ).run(
        qtyAfter,
        reservedAfter,
        item.productId,
        DEFAULT_WAREHOUSE_ID
      );

      appendInventoryMovement({
        productId: item.productId,
        warehouseId: DEFAULT_WAREHOUSE_ID,
        movementType: 'outbound',
        sourceType: 'delivery_note',
        sourceId: deliveryId,
        qtyChange: -item.quantity,
        reservedChange: -releaseQty,
        qtyBefore: stock.currentStock,
        qtyAfter,
        reservedBefore: stock.reservedStock,
        reservedAfter,
        occurredAt: movementOccurredAt,
        remark: `发货出库 ${shipment.orderId}`,
      });

      insertStockOut.run(
        `${deliveryId}-OUT-${index + 1}`,
        deliveryId,
        shipment.orderId,
        item.productId,
        DEFAULT_WAREHOUSE_ID,
        item.quantity,
        shippedAtDate,
      );
    });

    db.prepare('DELETE FROM stock_reservations WHERE sales_order_id = ?').run(shipment.orderId);

    db.prepare(
      'UPDATE delivery_notes SET shipment_status = ?, courier = ?, tracking_no = ?, shipped_at = ?, remark = ? WHERE id = ?'
    ).run('已发货', courier, trackingNo, shippedAtDate, '系统完成出库并登记物流信息。', deliveryId);

    db.prepare('UPDATE sales_orders SET status = ?, stock_status = ? WHERE id = ?').run('已发货', '-', shipment.orderId);

    appendAuditLog('dispatch_shipment', 'delivery_note', deliveryId, {
      orderId: shipment.orderId,
      courier,
      trackingNo,
      itemCount: itemStocks.length,
      warehouseId: DEFAULT_WAREHOUSE_ID,
    });
  });

  transaction();

  return toShippingRecord(loadShipment(deliveryId) as ShipmentRow);
}