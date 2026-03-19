import { appendAuditLog, appendInventoryMovement, createReceivableForSalesOrder, db, nextDocumentId, upsertCustomerProfile } from '../../database/db';
import { currentDateString, currentDateTimeString, formatCurrency } from '../../shared/format';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';

export type OrderStatus = '待发货' | '已发货' | '已完成' | '已取消';
export type StockStatus = '库存充足' | '部分缺货' | '待校验' | '-';
export type OrderStatusUpdate = '已完成' | '已取消';

const ORDER_STATUS_PENDING: OrderStatus = '待发货';
const ORDER_STATUS_SHIPPED: OrderStatus = '已发货';
const ORDER_STATUS_COMPLETED: OrderStatus = '已完成';
const ORDER_STATUS_CANCELLED: OrderStatus = '已取消';
const STOCK_STATUS_AVAILABLE: StockStatus = '库存充足';
const STOCK_STATUS_PARTIAL: StockStatus = '部分缺货';
const STOCK_STATUS_NONE: StockStatus = '-';

export interface OrderItemPayload {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateOrderPayload {
  customerName: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  remark?: string;
  sourceOrderNo?: string;
  sourceSystem?: string;
  bizNo?: string;
  idempotencyKey?: string;
  items: OrderItemPayload[];
}

export interface ImportSourceRow {
  [key: string]: unknown;
}

export interface ImportRowError {
  rowNumber: number;
  identifier: string;
  reason: string;
}

export interface ImportBatchResult {
  totalCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  createdIds: string[];
  errors: ImportRowError[];
}

export interface OrderRecord {
  id: string;
  customer: string;
  date: string;
  amount: string;
  status: OrderStatus;
  stockStatus: StockStatus;
  itemCount: number;
  expectedDeliveryDate?: string;
  remark?: string;
}

export interface OrderDetailItem {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineAmount: number;
}

export interface OrderDetailRecord {
  id: string;
  customerName: string;
  orderChannel: string;
  orderDate: string;
  createdAt: string;
  expectedDeliveryDate: string;
  status: OrderStatus;
  stockStatus: StockStatus;
  totalAmount: number;
  itemCount: number;
  remark?: string;
  items: OrderDetailItem[];
  shipping?: {
    deliveryId: string;
    shipmentStatus: string;
    courier?: string;
    trackingNo?: string;
    shippedAt?: string;
  };
  receivable?: {
    receivableId: string;
    amountDue: number;
    amountPaid: number;
    remainingAmount: number;
    dueDate: string;
  };
}

interface OrderRow {
  id: string;
  customerName: string;
  orderChannel: string;
  orderDate: string;
  createdAt?: string;
  expectedDeliveryDate: string;
  status: OrderStatus;
  stockStatus: StockStatus;
  totalAmount: number;
  itemCount: number;
  remark: string | null;
  sourceOrderNo?: string | null;
  sourceSystem?: string | null;
  bizNo?: string | null;
  idempotencyKey?: string | null;
}

interface OrderItemRow {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

interface ImportedOrderDraft {
  orderNo: string;
  customerName: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  remark?: string;
  items: OrderItemPayload[];
  firstRowNumber: number;
}

interface ProductSnapshot {
  id: string;
  name: string;
  salePrice: number;
}

function normalizeImportKey(value: string) {
  return value.toLowerCase().replace(/[\s_\-()（）[\]{}:：/\\]/g, '');
}

function pickImportValue(row: ImportSourceRow, aliases: string[]) {
  const normalizedAliasSet = new Set(aliases.map((alias) => normalizeImportKey(alias)));
  const matchedEntry = Object.entries(row).find(([key]) => normalizedAliasSet.has(normalizeImportKey(key)));
  return matchedEntry?.[1];
}

function normalizeOptionalString(value: unknown) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim();
  }

  return '';
}

function parsePositiveInteger(value: unknown) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parsePositiveNumber(value: unknown) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function findActiveProductBySku(sku: string) {
  return db
    .prepare<ProductSnapshot>('SELECT id, name, sale_price as salePrice FROM products WHERE sku = ? AND status = ?')
    .get(sku, 'active');
}

function toOrderRecord(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    customer: `${row.customerName} / ${row.orderChannel}`,
    date: row.orderDate.includes('T') ? row.orderDate.slice(0, 10) : row.orderDate,
    amount: formatCurrency(row.totalAmount),
    status: row.status,
    stockStatus: row.stockStatus,
    itemCount: row.itemCount,
    expectedDeliveryDate: row.expectedDeliveryDate,
    remark: row.remark ?? undefined,
  };
}

function detectStockStatus(items: OrderItemPayload[]): StockStatus {
  for (const item of items) {
    const stockRow = db.prepare<{ currentStock: number; transitStock: number }>(`
      SELECT
        COALESCE((SELECT SUM(current_stock - reserved_stock) FROM inventory i JOIN products p ON p.id = i.product_id WHERE p.sku = ? AND p.status = 'active'), 0) as currentStock,
        COALESCE((
          SELECT SUM(CASE WHEN poi.ordered_qty > poi.arrived_qty THEN poi.ordered_qty - poi.arrived_qty ELSE 0 END)
          FROM purchase_order_items poi
          JOIN products p ON p.id = poi.product_id
          JOIN purchase_orders po ON po.id = poi.purchase_order_id
          WHERE p.sku = ? AND p.status = 'active' AND po.status IN ('采购中', '部分到货')
        ), 0) as transitStock
    `).get(item.sku, item.sku);

    const available = (stockRow?.currentStock ?? 0) + (stockRow?.transitStock ?? 0);
    if (available < item.quantity) {
      return STOCK_STATUS_PARTIAL;
    }
  }

  return STOCK_STATUS_AVAILABLE;
}

function buildIdempotencyKey(payload: CreateOrderPayload) {
  const seed = [
    payload.sourceSystem?.trim() || 'manual',
    payload.sourceOrderNo?.trim() || '',
    payload.customerName.trim(),
    payload.expectedDeliveryDate,
  ].join('|');
  return seed ? seed.toUpperCase() : '';
}

function releaseOrderReservations(orderId: string, sourceType: string) {
  const reservations = db.prepare<{
    id: string;
    productId: string;
    warehouseId: string;
    quantity: number;
  }>(`
    SELECT id, product_id as productId, warehouse_id as warehouseId, quantity
    FROM stock_reservations
    WHERE sales_order_id = ?
    ORDER BY id ASC
  `).all(orderId);

  reservations.forEach((reservation) => {
    const stock = db.prepare<{ currentStock: number; reservedStock: number }>(
      'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
    ).get(reservation.productId, reservation.warehouseId);
    if (!stock) {
      return;
    }

    const reservedBefore = stock.reservedStock;
    if (stock.reservedStock < reservation.quantity) {
      throw new Error(`Reservation inconsistency for order ${orderId}: reserved=${stock.reservedStock}, release=${reservation.quantity}`);
    }

    const reservedAfter = stock.reservedStock - reservation.quantity;
    db.prepare('UPDATE inventory SET reserved_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
      reservedAfter,
      reservation.productId,
      reservation.warehouseId,
    );

    appendInventoryMovement({
      productId: reservation.productId,
      warehouseId: reservation.warehouseId,
      movementType: 'release',
      sourceType,
      sourceId: orderId,
      qtyChange: 0,
      reservedChange: -reservation.quantity,
      qtyBefore: stock.currentStock,
      qtyAfter: stock.currentStock,
      reservedBefore,
      reservedAfter,
      occurredAt: new Date().toISOString(),
      remark: '订单预留释放',
    });
  });

  db.prepare('DELETE FROM stock_reservations WHERE sales_order_id = ?').run(orderId);
  return reservations.length;
}

export function listOrders() {
  const rows = db.prepare<OrderRow>(`
    SELECT
      id,
      customer_name as customerName,
      order_channel as orderChannel,
      order_date as orderDate,
      COALESCE(created_at, CASE WHEN instr(order_date, 'T') > 0 THEN order_date ELSE order_date || 'T09:00:00.000Z' END) as createdAt,
      expected_delivery_date as expectedDeliveryDate,
      status,
      stock_status as stockStatus,
      total_amount as totalAmount,
      item_count as itemCount,
      remark
    FROM sales_orders
    ORDER BY order_date DESC, id DESC
  `).all();

  return rows.map(toOrderRecord);
}

export function getOrderDetail(orderId: string): OrderDetailRecord | null {
  const row = db.prepare<OrderRow>(`
    SELECT
      id,
      customer_name as customerName,
      order_channel as orderChannel,
      order_date as orderDate,
      COALESCE(created_at, CASE WHEN instr(order_date, 'T') > 0 THEN order_date ELSE order_date || 'T09:00:00.000Z' END) as createdAt,
      expected_delivery_date as expectedDeliveryDate,
      status,
      stock_status as stockStatus,
      total_amount as totalAmount,
      item_count as itemCount,
      remark
    FROM sales_orders
    WHERE id = ?
  `).get(orderId);

  if (!row) {
    return null;
  }

  const items = db.prepare<OrderItemRow>(`
    SELECT
      id,
      sku,
      product_name as productName,
      quantity,
      unit_price as unitPrice
    FROM sales_order_items
    WHERE sales_order_id = ?
    ORDER BY id ASC
  `).all(orderId);

  const shipping = db.prepare<{
    deliveryId: string;
    shipmentStatus: string;
    courier: string | null;
    trackingNo: string | null;
    shippedAt: string | null;
  }>(`
    SELECT
      id as deliveryId,
      shipment_status as shipmentStatus,
      courier,
      tracking_no as trackingNo,
      shipped_at as shippedAt
    FROM delivery_notes
    WHERE sales_order_id = ?
  `).get(orderId);

  const receivable = db.prepare<{
    receivableId: string;
    amountDue: number;
    amountPaid: number;
    dueDate: string;
  }>(`
    SELECT
      id as receivableId,
      amount_due as amountDue,
      amount_paid as amountPaid,
      due_date as dueDate
    FROM receivables
    WHERE sales_order_id = ?
  `).get(orderId);

  return {
    id: row.id,
    customerName: row.customerName,
    orderChannel: row.orderChannel,
    orderDate: row.orderDate,
    createdAt: row.createdAt || (row.orderDate.includes('T') ? row.orderDate : `${row.orderDate}T09:00:00.000Z`),
    expectedDeliveryDate: row.expectedDeliveryDate,
    status: row.status,
    stockStatus: row.stockStatus,
    totalAmount: row.totalAmount,
    itemCount: row.itemCount,
    remark: row.remark ?? undefined,
    items: items.map((item) => ({
      ...item,
      lineAmount: item.quantity * item.unitPrice,
    })),
    shipping: shipping
      ? {
          deliveryId: shipping.deliveryId,
          shipmentStatus: shipping.shipmentStatus,
          courier: shipping.courier ?? undefined,
          trackingNo: shipping.trackingNo ?? undefined,
          shippedAt: shipping.shippedAt ?? undefined,
        }
      : undefined,
    receivable: receivable
      ? {
          receivableId: receivable.receivableId,
          amountDue: receivable.amountDue,
          amountPaid: receivable.amountPaid,
          remainingAmount: Math.max(receivable.amountDue - receivable.amountPaid, 0),
          dueDate: receivable.dueDate,
        }
      : undefined,
  };
}

export function createOrder(payload: CreateOrderPayload) {
  const totalAmount = payload.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const itemCount = payload.items.reduce((sum, item) => sum + item.quantity, 0);
  const orderDate = currentDateString();
  const createdAt = currentDateTimeString();
  const orderId = nextDocumentId('sales_orders', 'ORD', orderDate);
  const normalizedSourceOrderNo = payload.sourceOrderNo?.trim() || null;
  const normalizedSourceSystem = payload.sourceSystem?.trim() || null;
  const normalizedBizNo = payload.bizNo?.trim() || normalizedSourceOrderNo;
  const normalizedIdempotencyKey = payload.idempotencyKey?.trim() || buildIdempotencyKey(payload) || null;

  if (normalizedIdempotencyKey) {
    const existing = db
      .prepare<{ id: string }>('SELECT id FROM sales_orders WHERE idempotency_key = ?')
      .get(normalizedIdempotencyKey);
    if (existing?.id) {
      throw new Error(`Duplicate order request detected (idempotency key: ${normalizedIdempotencyKey})`);
    }
  }

  const transaction = db.transaction(() => {
    const deliveryId = nextDocumentId('delivery_notes', 'SHP', orderDate);
    let hasShortage = false;

    db.prepare(
      `INSERT INTO sales_orders (
        id, customer_name, order_channel, order_date, created_at, expected_delivery_date, status, stock_status, total_amount, item_count, remark, source_order_no, source_system, biz_no, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      orderId,
      payload.customerName.trim(),
      payload.orderChannel.trim(),
      orderDate,
      createdAt,
      payload.expectedDeliveryDate,
      ORDER_STATUS_PENDING,
      STOCK_STATUS_AVAILABLE,
      totalAmount,
      itemCount,
      payload.remark?.trim() || null,
      normalizedSourceOrderNo,
      normalizedSourceSystem,
      normalizedBizNo,
      normalizedIdempotencyKey
    );

    const insertItem = db.prepare(
      'INSERT INTO sales_order_items (id, sales_order_id, product_id, sku, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    payload.items.forEach((item, index) => {
      const product = db.prepare<{ id: string }>("SELECT id FROM products WHERE sku = ? AND status = 'active'").get(item.sku);
      if (!product) {
        throw new Error(`Active product not found for SKU ${item.sku}`);
      }
      insertItem.run(
        `${orderId}-ITEM-${index + 1}`,
        orderId,
        product.id,
        item.sku,
        item.productName,
        item.quantity,
        item.unitPrice
      );

      const inventorySnapshot = db.prepare<{ currentStock: number; reservedStock: number }>(
        "SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?",
      ).get(product.id, DEFAULT_WAREHOUSE_ID);

      if (!inventorySnapshot) {
        hasShortage = true;
        return;
      }

      const available = Math.max(inventorySnapshot.currentStock - inventorySnapshot.reservedStock, 0);
      const reserveQty = Math.min(available, item.quantity);
      if (reserveQty <= 0) {
        hasShortage = true;
        return;
      }

      if (reserveQty < item.quantity) {
        hasShortage = true;
      }

      const reservedBefore = inventorySnapshot.reservedStock;
      const reservedAfter = inventorySnapshot.reservedStock + reserveQty;

      db.prepare("UPDATE inventory SET reserved_stock = ? WHERE product_id = ? AND warehouse_id = ?").run(
        reservedAfter,
        product.id,
        DEFAULT_WAREHOUSE_ID,
      );
      db.prepare(`
        INSERT INTO stock_reservations (id, sales_order_id, product_id, warehouse_id, quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`${orderId}-RES-${index + 1}`, orderId, product.id, DEFAULT_WAREHOUSE_ID, reserveQty, createdAt, createdAt);

      appendInventoryMovement({
        productId: product.id,
        warehouseId: DEFAULT_WAREHOUSE_ID,
        movementType: 'reserve',
        sourceType: 'sales_order',
        sourceId: orderId,
        qtyChange: 0,
        reservedChange: reserveQty,
        qtyBefore: inventorySnapshot.currentStock,
        qtyAfter: inventorySnapshot.currentStock,
        reservedBefore,
        reservedAfter,
        occurredAt: createdAt,
        remark: `订单预留 ${item.sku}`,
      });
    });

    db.prepare(
      `INSERT INTO delivery_notes (
        id, sales_order_id, created_at, shipment_status, courier, tracking_no, shipped_at, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(deliveryId, orderId, createdAt, ORDER_STATUS_PENDING, null, null, null, 'Pending delivery note created automatically.');

    db.prepare('UPDATE sales_orders SET stock_status = ? WHERE id = ?').run(
      hasShortage ? STOCK_STATUS_PARTIAL : STOCK_STATUS_AVAILABLE,
      orderId,
    );

    createReceivableForSalesOrder(orderId, {
      seedByStatus: false,
      remark: '订单创建后自动生成应收记录。',
    });

    appendAuditLog('create_order', 'sales_order', orderId, {
      customerName: payload.customerName.trim(),
      orderChannel: payload.orderChannel.trim(),
      sourceOrderNo: normalizedSourceOrderNo,
      sourceSystem: normalizedSourceSystem,
      bizNo: normalizedBizNo,
      idempotencyKey: normalizedIdempotencyKey,
      itemCount,
      totalAmount,
    });

    upsertCustomerProfile(payload.customerName.trim(), payload.orderChannel.trim(), orderDate, totalAmount);
  });

  transaction();

  const row = db.prepare<OrderRow>(`
    SELECT
      id,
      customer_name as customerName,
      order_channel as orderChannel,
      order_date as orderDate,
      COALESCE(created_at, CASE WHEN instr(order_date, 'T') > 0 THEN order_date ELSE order_date || 'T09:00:00.000Z' END) as createdAt,
      expected_delivery_date as expectedDeliveryDate,
      status,
      stock_status as stockStatus,
      total_amount as totalAmount,
      item_count as itemCount,
      remark
    FROM sales_orders
    WHERE id = ?
  `).get(orderId);

  return toOrderRecord(row as OrderRow);
}

export function importOrders(rows: ImportSourceRow[]): ImportBatchResult {
  const errors: ImportRowError[] = [];
  const createdIds: string[] = [];
  let createdCount = 0;
  let skippedCount = 0;
  const groupedOrders = new Map<string, ImportedOrderDraft>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const orderNo = normalizeOptionalString(
      pickImportValue(row, ['orderNo', 'orderCode', 'importOrderNo', '订单组', '导入单号', '订单导入号', '批次单号']),
    );
    const customerName = normalizeOptionalString(
      pickImportValue(row, ['customerName', 'customer', '客户名称', '客户']),
    );
    const orderChannel = normalizeOptionalString(
      pickImportValue(row, ['orderChannel', 'channel', '渠道', '订单渠道']),
    );
    const expectedDeliveryDate = normalizeOptionalString(
      pickImportValue(row, ['expectedDeliveryDate', 'deliveryDate', '交付日期', '期望交付日期']),
    );
    const remark = normalizeOptionalString(pickImportValue(row, ['remark', '备注']));
    const sku = normalizeOptionalString(
      pickImportValue(row, ['sku', 'SKU', '商品编码', '商品编号', '货号']),
    ).toUpperCase();
    const productName = normalizeOptionalString(
      pickImportValue(row, ['productName', 'product', '商品名称', '商品']),
    );
    const quantity = parsePositiveInteger(
      pickImportValue(row, ['quantity', 'qty', '数量']),
    );
    const unitPrice = parsePositiveNumber(
      pickImportValue(row, ['unitPrice', 'price', '单价', '销售单价', '售价']),
    );

    if (!orderNo && !customerName && !orderChannel && !expectedDeliveryDate && !sku && quantity === null && !productName) {
      skippedCount += 1;
      return;
    }

    const missingFields = [
      !orderNo ? 'orderNo' : '',
      !customerName ? 'customerName' : '',
      !orderChannel ? 'orderChannel' : '',
      !expectedDeliveryDate ? 'expectedDeliveryDate' : '',
      !sku ? 'sku' : '',
      quantity === null ? 'quantity' : '',
    ].filter(Boolean);

    if (missingFields.length > 0) {
      errors.push({
        rowNumber,
        identifier: orderNo || sku || `row-${rowNumber}`,
        reason: `缺少或无法解析字段：${missingFields.join('、')}`,
      });
      return;
    }

    const product = findActiveProductBySku(sku);
    if (!product) {
      errors.push({
        rowNumber,
        identifier: orderNo || sku || `row-${rowNumber}`,
        reason: `未找到启用中的商品 SKU：${sku}`,
      });
      return;
    }

    const resolvedPrice = unitPrice ?? product.salePrice;
    const resolvedProductName = productName || product.name;
    const existingOrder = groupedOrders.get(orderNo);
    if (existingOrder) {
      const sameHeader =
        existingOrder.customerName === customerName &&
        existingOrder.orderChannel === orderChannel &&
        existingOrder.expectedDeliveryDate === expectedDeliveryDate &&
        (existingOrder.remark || '') === remark;

      if (!sameHeader) {
        errors.push({
          rowNumber,
          identifier: orderNo,
          reason: '同一个 orderNo 的客户、渠道、交付日期或备注不一致',
        });
        return;
      }

      existingOrder.items.push({
        sku,
        productName: resolvedProductName,
        quantity: quantity as number,
        unitPrice: resolvedPrice,
      });
      return;
    }

    groupedOrders.set(orderNo, {
      orderNo,
      customerName,
      orderChannel,
      expectedDeliveryDate,
      remark: remark || undefined,
      firstRowNumber: rowNumber,
      items: [
        {
          sku,
          productName: resolvedProductName,
          quantity: quantity as number,
          unitPrice: resolvedPrice,
        },
      ],
    });
  });

  groupedOrders.forEach((draft) => {
    try {
      const order = createOrder({
        customerName: draft.customerName,
        orderChannel: draft.orderChannel,
        expectedDeliveryDate: draft.expectedDeliveryDate,
        remark: draft.remark,
        sourceOrderNo: draft.orderNo,
        sourceSystem: 'import',
        bizNo: draft.orderNo,
        idempotencyKey: `IMPORT|${draft.orderNo}`.toUpperCase(),
        items: draft.items,
      });
      createdCount += 1;
      createdIds.push(order.id);
    } catch (error) {
      errors.push({
        rowNumber: draft.firstRowNumber,
        identifier: draft.orderNo,
        reason: error instanceof Error ? error.message : 'Create order failed',
      });
    }
  });

  return {
    totalCount: rows.length,
    createdCount,
    skippedCount,
    errorCount: errors.length,
    createdIds,
    errors,
  };
}

export function updateOrderStatus(orderId: string, nextStatus: OrderStatusUpdate) {
  const order = db.prepare<OrderRow>(`
    SELECT
      id,
      customer_name as customerName,
      order_channel as orderChannel,
      order_date as orderDate,
      COALESCE(created_at, CASE WHEN instr(order_date, 'T') > 0 THEN order_date ELSE order_date || 'T09:00:00.000Z' END) as createdAt,
      expected_delivery_date as expectedDeliveryDate,
      status,
      stock_status as stockStatus,
      total_amount as totalAmount,
      item_count as itemCount,
      remark
    FROM sales_orders
    WHERE id = ?
  `).get(orderId);

  if (!order) {
    throw new Error('Order not found');
  }

  if (nextStatus === ORDER_STATUS_CANCELLED) {
    if (order.status !== ORDER_STATUS_PENDING) {
      throw new Error('Only pending orders can be cancelled');
    }

    const receivable = db.prepare<{ id: string; amountPaid: number }>(
      'SELECT id, amount_paid as amountPaid FROM receivables WHERE sales_order_id = ?'
    ).get(orderId);
    if ((receivable?.amountPaid ?? 0) > 0) {
      throw new Error('Order already has receipts and cannot be cancelled');
    }

    const transaction = db.transaction(() => {
      const releasedCount = releaseOrderReservations(orderId, 'cancel_order');

      if (receivable) {
        db.prepare('DELETE FROM receipt_records WHERE receivable_id = ?').run(receivable.id);
        db.prepare('DELETE FROM receivables WHERE id = ?').run(receivable.id);
      }

      db.prepare('DELETE FROM delivery_notes WHERE sales_order_id = ?').run(orderId);
      db.prepare('UPDATE sales_orders SET status = ?, stock_status = ? WHERE id = ?').run(ORDER_STATUS_CANCELLED, STOCK_STATUS_NONE, orderId);

      appendAuditLog('cancel_order', 'sales_order', orderId, {
        previousStatus: order.status,
        reservationReleasedCount: releasedCount,
      });
    });

    transaction();
    return getOrderDetail(orderId) as OrderDetailRecord;
  }

  if (nextStatus === ORDER_STATUS_COMPLETED) {
    if (order.status !== ORDER_STATUS_SHIPPED) {
      throw new Error('Only shipped orders can be completed');
    }

    db.prepare('UPDATE sales_orders SET status = ?, stock_status = ? WHERE id = ?').run(ORDER_STATUS_COMPLETED, STOCK_STATUS_NONE, orderId);
    appendAuditLog('complete_order', 'sales_order', orderId, {
      previousStatus: order.status,
    });

    return getOrderDetail(orderId) as OrderDetailRecord;
  }

  throw new Error('Unsupported order status');
}

export function deleteOrder(orderId: string, options?: { aggressive?: boolean }) {
  const aggressive = Boolean(options?.aggressive);
  const existing = db
    .prepare<{ id: string; status: string; customerName: string }>(
      'SELECT id, status as status, customer_name as customerName FROM sales_orders WHERE id = ?',
    )
    .get(orderId);
  if (!existing) {
    throw new Error('Order not found');
  }

  const transaction = db.transaction(() => {
    const releasedCount = releaseOrderReservations(orderId, aggressive ? 'delete_order_force' : 'delete_order');

    const stockOutRows = db
      .prepare<{ productId: string; warehouseId: string; quantity: number }>(
        'SELECT product_id as productId, warehouse_id as warehouseId, quantity FROM stock_out_records WHERE sales_order_id = ?',
      )
      .all(orderId);

    if (!aggressive && stockOutRows.length > 0) {
      throw new Error('Order has outbound records. Enable aggressive delete to force remove.');
    }

    const receivableIds = db
      .prepare<{ id: string }>('SELECT id FROM receivables WHERE sales_order_id = ?')
      .all(orderId)
      .map((item) => item.id);

    const receiptCount = receivableIds.reduce((sum, receivableId) => {
      const count =
        db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM receipt_records WHERE receivable_id = ?').get(receivableId)
          ?.count ?? 0;
      return sum + count;
    }, 0);
    if (!aggressive && receiptCount > 0) {
      throw new Error('Order has receipts. Enable aggressive delete to force remove.');
    }

    if (aggressive) {
      stockOutRows.forEach((row) => {
        const stock = db
          .prepare<{ currentStock: number; reservedStock: number }>(
            'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
          )
          .get(row.productId, row.warehouseId);
        if (!stock) {
          throw new Error(`Inventory record missing while rolling back shipment for order ${orderId}`);
        }

        const qtyAfter = stock.currentStock + row.quantity;
        db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
          qtyAfter,
          row.productId,
          row.warehouseId,
        );

        appendInventoryMovement({
          productId: row.productId,
          warehouseId: row.warehouseId,
          movementType: 'reverse',
          sourceType: 'sales_order',
          sourceId: orderId,
          qtyChange: row.quantity,
          reservedChange: 0,
          qtyBefore: stock.currentStock,
          qtyAfter,
          reservedBefore: stock.reservedStock,
          reservedAfter: stock.reservedStock,
          occurredAt: new Date().toISOString(),
          remark: '删除订单回滚已发货库存',
        });
      });
    }

    receivableIds.forEach((receivableId) => {
      db.prepare('DELETE FROM receipt_records WHERE receivable_id = ?').run(receivableId);
    });
    db.prepare('DELETE FROM receivables WHERE sales_order_id = ?').run(orderId);
    db.prepare('DELETE FROM stock_out_records WHERE sales_order_id = ?').run(orderId);
    db.prepare('DELETE FROM delivery_notes WHERE sales_order_id = ?').run(orderId);
    db.prepare('DELETE FROM sales_order_items WHERE sales_order_id = ?').run(orderId);
    db.prepare('DELETE FROM sales_orders WHERE id = ?').run(orderId);

    appendAuditLog(aggressive ? 'delete_order_force' : 'delete_order', 'sales_order', orderId, {
      previousStatus: existing.status,
      customerName: existing.customerName,
      stockRollbackCount: aggressive ? stockOutRows.length : 0,
      reservationReleasedCount: releasedCount,
    });
  });

  transaction();

  return {
    id: orderId,
    deleted: true,
  };
}
