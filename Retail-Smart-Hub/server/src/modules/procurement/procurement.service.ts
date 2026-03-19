import { appendAuditLog, appendInventoryMovement, createPayableForPurchaseOrder, db, nextDocumentId } from '../../database/db';
import { addDays, currentDateString, formatCurrency } from '../../shared/format';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';

export interface ProcurementOrder {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: string;
  source: string;
}

export interface ProcurementOrderDetail {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: string;
  source: string;
  remark?: string;
  itemCount: number;
  items: Array<{
    id: string;
    sku: string;
    productName: string;
    orderedQty: number;
    arrivedQty: number;
    unitCost: number;
    lineAmount: number;
  }>;
}

interface ProcurementRow {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: number;
  source: string;
  remark?: string | null;
}

interface ProcurementItemRow {
  id: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
  unitCost: number;
}

interface SuggestedItem {
  productId: string;
  sku: string;
  name: string;
  recommendQty: number;
  supplierId: string;
  supplierName: string;
  leadTimeDays: number;
  unitCost: number;
}

const ALLOWED_PROCUREMENT_STATUSES = new Set(['待审核', '采购中', '部分到货', '已完成', '已取消']);

export interface ProcurementSuggestionSummary {
  lowStockItemCount: number;
  recommendedOrderCount: number;
  recommendedSkus: string[];
  message: string;
}

export interface GeneratedPurchaseOrder {
  id: string;
  supplier: string;
  amount: string;
  itemCount: number;
  status: string;
}

function loadSuggestedItems() {
  return db.prepare<SuggestedItem>(`
    SELECT
      p.id as productId,
      p.sku,
      p.name,
      CASE
        WHEN (p.safe_stock * 2) - COALESCE(inv.currentStock, 0) - COALESCE(transit.transitStock, 0) > 0
        THEN (p.safe_stock * 2) - COALESCE(inv.currentStock, 0) - COALESCE(transit.transitStock, 0)
        ELSE 0
      END as recommendQty,
      s.id as supplierId,
      s.name as supplierName,
      s.lead_time_days as leadTimeDays,
      p.cost_price as unitCost
    FROM products p
    JOIN suppliers s ON s.id = p.preferred_supplier_id
    LEFT JOIN (
      SELECT product_id, SUM(current_stock) as currentStock
      FROM inventory
      GROUP BY product_id
    ) inv ON inv.product_id = p.id
    LEFT JOIN (
      SELECT
        poi.product_id as product_id,
        SUM(CASE WHEN poi.ordered_qty > poi.arrived_qty THEN poi.ordered_qty - poi.arrived_qty ELSE 0 END) as transitStock
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('采购中', '部分到货')
      GROUP BY product_id
    ) transit ON transit.product_id = p.id
    WHERE p.status = 'active'
      AND s.status = 'active'
      AND COALESCE(inv.currentStock, 0) + COALESCE(transit.transitStock, 0) < p.safe_stock
    ORDER BY recommendQty DESC, p.sku ASC
  `).all();
}

export function listProcurementOrders() {
  const rows = db.prepare<ProcurementRow>(`
    SELECT
      po.id,
      s.name as supplier,
      po.created_at as createDate,
      po.expected_at as expectedDate,
      po.status,
      po.source,
      COALESCE(SUM(poi.ordered_qty * poi.unit_cost), 0) as amount
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    GROUP BY po.id, s.name, po.created_at, po.expected_at, po.status, po.source
    ORDER BY po.created_at DESC, po.id DESC
  `).all();

  return rows.map((row) => ({
    ...row,
    amount: formatCurrency(row.amount),
  }));
}

export function getProcurementOrderDetail(id: string): ProcurementOrderDetail | null {
  const row = db.prepare<ProcurementRow>(`
    SELECT
      po.id,
      s.name as supplier,
      po.created_at as createDate,
      po.expected_at as expectedDate,
      po.status,
      po.source,
      po.remark,
      COALESCE(SUM(poi.ordered_qty * poi.unit_cost), 0) as amount
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    WHERE po.id = ?
    GROUP BY po.id, s.name, po.created_at, po.expected_at, po.status, po.source, po.remark
  `).get(id);

  if (!row) {
    return null;
  }

  const items = db.prepare<ProcurementItemRow>(`
    SELECT
      poi.id,
      p.sku,
      p.name as productName,
      poi.ordered_qty as orderedQty,
      poi.arrived_qty as arrivedQty,
      poi.unit_cost as unitCost
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ?
    ORDER BY poi.id ASC
  `).all(id);

  return {
    id: row.id,
    supplier: row.supplier,
    createDate: row.createDate,
    expectedDate: row.expectedDate,
    status: row.status,
    amount: formatCurrency(row.amount),
    source: row.source,
    remark: row.remark ?? undefined,
    itemCount: items.reduce((sum, item) => sum + item.orderedQty, 0),
    items: items.map((item) => ({
      ...item,
      lineAmount: item.orderedQty * item.unitCost,
    })),
  };
}

export function getProcurementSuggestions(): ProcurementSuggestionSummary {
  const items = loadSuggestedItems();
  const suppliers = new Set(items.map((item) => item.supplierId));

  return {
    lowStockItemCount: items.length,
    recommendedOrderCount: suppliers.size,
    recommendedSkus: items.map((item) => item.sku),
    message:
      items.length > 0
        ? `检测到 ${items.length} 个商品低于安全库存，建议生成 ${suppliers.size} 张补货采购单。`
        : '当前库存健康，无需新增采购单。',
  };
}

export function generateSuggestedPurchaseOrders() {
  const items = loadSuggestedItems();
  if (items.length === 0) {
    return [] as GeneratedPurchaseOrder[];
  }

  const today = currentDateString();
  const groups = new Map<string, SuggestedItem[]>();
  items.forEach((item) => {
    const current = groups.get(item.supplierId) ?? [];
    current.push(item);
    groups.set(item.supplierId, current);
  });

  const transaction = db.transaction(() => {
    const created: GeneratedPurchaseOrder[] = [];
    const insertPo = db.prepare(
      'INSERT INTO purchase_orders (id, supplier_id, created_at, expected_at, status, source, remark) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertItem = db.prepare(
      'INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, arrived_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)'
    );

    groups.forEach((supplierItems, supplierId) => {
      const poId = nextDocumentId('purchase_orders', 'PO', today);
      const expectedDate = addDays(today, supplierItems[0].leadTimeDays);
      const totalAmount = supplierItems.reduce((sum, item) => sum + item.recommendQty * item.unitCost, 0);

      insertPo.run(
        poId,
        supplierId,
        today,
        expectedDate,
        '待审核',
        '低库存自动补货',
        `由系统自动生成，包含 ${supplierItems.length} 个补货 SKU。`
      );

      supplierItems.forEach((item, index) => {
        insertItem.run(
          `${poId}-ITEM-${index + 1}`,
          poId,
          item.productId,
          item.recommendQty,
          0,
          item.unitCost
        );
      });

      createPayableForPurchaseOrder(poId, {
        seedByStatus: false,
        remark: '采购单创建后自动生成应付记录。',
      });

      appendAuditLog('create_purchase_order', 'purchase_order', poId, {
        source: 'low_stock_auto_generation',
        supplierId,
        skuList: supplierItems.map((item) => item.sku),
      });

      created.push({
        id: poId,
        supplier: supplierItems[0].supplierName,
        amount: formatCurrency(totalAmount),
        itemCount: supplierItems.length,
        status: '待审核',
      });
    });

    return created;
  });

  return transaction();
}

export function updateProcurementOrderStatus(id: string, nextStatus: string) {
  if (!ALLOWED_PROCUREMENT_STATUSES.has(nextStatus)) {
    throw new Error('Unsupported procurement status');
  }

  const existing = db
    .prepare<{ id: string; status: string }>('SELECT id, status FROM purchase_orders WHERE id = ?')
    .get(id);
  if (!existing) {
    throw new Error('Procurement order not found');
  }

  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(nextStatus, id);
  appendAuditLog('force_update_purchase_order_status', 'purchase_order', id, {
    previousStatus: existing.status,
    nextStatus,
  });

  return getProcurementOrderDetail(id);
}

export function deleteProcurementOrder(id: string, options?: { aggressive?: boolean }) {
  const aggressive = Boolean(options?.aggressive);
  const existing = db
    .prepare<{ id: string; status: string }>('SELECT id, status FROM purchase_orders WHERE id = ?')
    .get(id);
  if (!existing) {
    throw new Error('Procurement order not found');
  }

  const transaction = db.transaction(() => {
    const receivingCount =
      db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM receiving_notes WHERE purchase_order_id = ?').get(id)?.count ?? 0;
    if (!aggressive && receivingCount > 0) {
      throw new Error('Procurement order has receiving records. Enable aggressive delete to force remove.');
    }

    const inboundRows = db
      .prepare<{ id: string; status: string; receivingNoteId: string; warehouseId: string }>(`
        SELECT
          io.id as id,
          io.status as status,
          io.receiving_note_id as receivingNoteId,
          io.warehouse_id as warehouseId
        FROM inbound_orders io
        JOIN receiving_notes rn ON rn.id = io.receiving_note_id
        WHERE rn.purchase_order_id = ?
      `)
      .all(id);

    inboundRows.forEach((inbound) => {
      if (inbound.status === '已入库') {
        const items = db
          .prepare<{ productId: string; qualifiedQty: number }>(
            'SELECT product_id as productId, qualified_qty as qualifiedQty FROM receiving_note_items WHERE receiving_note_id = ?',
          )
          .all(inbound.receivingNoteId);

        items.forEach((item) => {
          const stock = db
            .prepare<{ currentStock: number; reservedStock: number }>(
              "SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?",
            )
            .get(item.productId, inbound.warehouseId || DEFAULT_WAREHOUSE_ID);
          if (!stock) {
            throw new Error(`Inventory record missing while rolling back procurement ${id}`);
          }
          if (stock.currentStock < item.qualifiedQty) {
            throw new Error(
              `Inventory inconsistency for rollback: product ${item.productId} current=${stock.currentStock}, rollback=${item.qualifiedQty}`,
            );
          }

          const qtyAfter = stock.currentStock - item.qualifiedQty;
          db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
            qtyAfter,
            item.productId,
            inbound.warehouseId || DEFAULT_WAREHOUSE_ID,
          );

          appendInventoryMovement({
            productId: item.productId,
            warehouseId: inbound.warehouseId || DEFAULT_WAREHOUSE_ID,
            movementType: 'reverse',
            sourceType: 'purchase_order',
            sourceId: id,
            qtyChange: -item.qualifiedQty,
            reservedChange: 0,
            qtyBefore: stock.currentStock,
            qtyAfter,
            reservedBefore: stock.reservedStock,
            reservedAfter: stock.reservedStock,
            occurredAt: new Date().toISOString(),
            remark: `删除采购单回滚入库 ${inbound.receivingNoteId}`,
          });
        });
      }
    });

    db.prepare(`
      DELETE FROM inbound_orders
      WHERE receiving_note_id IN (
        SELECT id FROM receiving_notes WHERE purchase_order_id = ?
      )
    `).run(id);

    const payableIds = db
      .prepare<{ id: string }>('SELECT id FROM payables WHERE purchase_order_id = ?')
      .all(id)
      .map((item) => item.id);
    payableIds.forEach((payableId) => {
      db.prepare('DELETE FROM payment_records WHERE payable_id = ?').run(payableId);
    });
    db.prepare('DELETE FROM payables WHERE purchase_order_id = ?').run(id);
    db.prepare('DELETE FROM receiving_notes WHERE purchase_order_id = ?').run(id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);

    appendAuditLog(aggressive ? 'delete_purchase_order_force' : 'delete_purchase_order', 'purchase_order', id, {
      previousStatus: existing.status,
      removedInboundCount: inboundRows.length,
      aggressive,
    });
  });

  transaction();

  return {
    id,
    deleted: true,
  };
}
