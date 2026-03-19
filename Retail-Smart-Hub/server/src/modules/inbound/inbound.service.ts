import { appendAuditLog, appendInventoryMovement, db, nextDocumentId } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { recalculatePurchaseOrderStatus } from '../procurement/procurement-workflow.service';

const STATUS_PENDING_INBOUND = '\u5F85\u5165\u5E93';
const STATUS_INBOUND_DONE = '\u5DF2\u5165\u5E93';
const STATUS_RECEIVING_PENDING_INBOUND = '\u5DF2\u9A8C\u6536\u5F85\u5165\u5E93';

export interface InboundRecord {
  id: string;
  rcvId: string;
  supplier: string;
  items: number;
  warehouse: string;
  status: string;
}

export interface InboundDetailRecord extends InboundRecord {
  poId: string;
  completedAt?: string;
  itemsDetail: Array<{
    sku: string;
    productName: string;
    qualifiedQty: number;
  }>;
}

interface InboundRow extends InboundRecord {
  receivingNoteId: string;
  purchaseOrderId: string;
  completedAt: string | null;
  warehouseId: string;
}

interface InboundItemRow {
  productId: string;
  sku: string;
  productName: string;
  qualifiedQty: number;
}

const ALLOWED_INBOUND_STATUSES = new Set([STATUS_PENDING_INBOUND, STATUS_INBOUND_DONE]);

function loadInboundRows() {
  return db.prepare<InboundRow>(`
    SELECT
      io.id,
      io.receiving_note_id as receivingNoteId,
      rn.id as rcvId,
      rn.purchase_order_id as purchaseOrderId,
      s.name as supplier,
      io.inbound_qty as items,
      io.warehouse_id as warehouseId,
      w.location_code as warehouse,
      io.status,
      io.completed_at as completedAt
    FROM inbound_orders io
    JOIN receiving_notes rn ON rn.id = io.receiving_note_id
    JOIN suppliers s ON s.id = rn.supplier_id
    JOIN warehouses w ON w.id = io.warehouse_id
    ORDER BY io.id DESC
  `).all();
}

function loadInbound(id: string) {
  return db.prepare<InboundRow>(`
    SELECT
      io.id,
      io.receiving_note_id as receivingNoteId,
      rn.id as rcvId,
      rn.purchase_order_id as purchaseOrderId,
      s.name as supplier,
      io.inbound_qty as items,
      io.warehouse_id as warehouseId,
      w.location_code as warehouse,
      io.status,
      io.completed_at as completedAt
    FROM inbound_orders io
    JOIN receiving_notes rn ON rn.id = io.receiving_note_id
    JOIN suppliers s ON s.id = rn.supplier_id
    JOIN warehouses w ON w.id = io.warehouse_id
    WHERE io.id = ?
  `).get(id);
}

function loadInboundItemStocks(receivingNoteId: string) {
  return db.prepare<InboundItemRow>(`
    SELECT
      rni.product_id as productId,
      p.sku as sku,
      p.name as productName,
      rni.qualified_qty as qualifiedQty
    FROM receiving_note_items rni
    JOIN products p ON p.id = rni.product_id
    WHERE rni.receiving_note_id = ?
    ORDER BY rni.id ASC
  `).all(receivingNoteId);
}

export function listInbounds() {
  return loadInboundRows();
}

export function getInboundDetail(inboundId: string): InboundDetailRecord | null {
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    return null;
  }

  const items = loadInboundItemStocks(inbound.receivingNoteId);

  return {
    id: inbound.id,
    rcvId: inbound.rcvId,
    poId: inbound.purchaseOrderId,
    supplier: inbound.supplier,
    items: inbound.items,
    warehouse: inbound.warehouse,
    status: inbound.status,
    completedAt: inbound.completedAt ?? undefined,
    itemsDetail: items.map((item) => ({
      sku: item.sku,
      productName: item.productName,
      qualifiedQty: item.qualifiedQty,
    })),
  };
}

function applyInboundInventoryDelta(
  receivingNoteId: string,
  warehouseId: string,
  sourceId: string,
  direction: 'in' | 'out',
  occurredAt: string,
  remarkPrefix: string,
) {
  const items = db
    .prepare<{ productId: string; qualifiedQty: number }>(
      'SELECT product_id as productId, qualified_qty as qualifiedQty FROM receiving_note_items WHERE receiving_note_id = ?',
    )
    .all(receivingNoteId);

  items.forEach((item) => {
    let stock = db.prepare<{ currentStock: number; reservedStock: number }>(
      'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
    ).get(item.productId, warehouseId);

    if (!stock) {
      if (direction === 'out') {
        throw new Error(`Inventory record missing while reversing inbound: ${item.productId}`);
      }

      db.prepare('INSERT INTO inventory (id, product_id, warehouse_id, current_stock, reserved_stock) VALUES (?, ?, ?, ?, ?)').run(
        nextDocumentId('inventory', 'INV'),
        item.productId,
        warehouseId,
        0,
        0,
      );
      stock = { currentStock: 0, reservedStock: 0 };
    }

    const qtyBefore = stock.currentStock;
    const qtyAfter = direction === 'in' ? qtyBefore + item.qualifiedQty : qtyBefore - item.qualifiedQty;
    if (qtyAfter < 0) {
      throw new Error(`Inventory inconsistency for product ${item.productId}: current=${qtyBefore}, delta=${item.qualifiedQty}`);
    }

    db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
      qtyAfter,
      item.productId,
      warehouseId,
    );

    appendInventoryMovement({
      productId: item.productId,
      warehouseId,
      movementType: direction === 'in' ? 'inbound' : 'reverse',
      sourceType: 'inbound_order',
      sourceId,
      qtyChange: direction === 'in' ? item.qualifiedQty : -item.qualifiedQty,
      reservedChange: 0,
      qtyBefore,
      qtyAfter,
      reservedBefore: stock.reservedStock,
      reservedAfter: stock.reservedStock,
      occurredAt,
      remark: `${remarkPrefix} ${receivingNoteId}`,
    });
  });
}

export function confirmInbound(inboundId: string) {
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    throw new Error('Inbound order not found');
  }

  if (inbound.status === STATUS_INBOUND_DONE) {
    return inbound;
  }

  const items = loadInboundItemStocks(inbound.receivingNoteId);
  const today = currentDateString();
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    applyInboundInventoryDelta(inbound.receivingNoteId, inbound.warehouseId, inboundId, 'in', now, 'inbound_confirm');

    db.prepare('UPDATE inbound_orders SET status = ?, completed_at = ? WHERE id = ?').run(STATUS_INBOUND_DONE, today, inboundId);
    db.prepare('UPDATE receiving_notes SET status = ? WHERE id = ?').run(STATUS_INBOUND_DONE, inbound.receivingNoteId);
    recalculatePurchaseOrderStatus(inbound.purchaseOrderId);

    appendAuditLog('confirm_inbound', 'inbound_order', inboundId, {
      receivingNoteId: inbound.receivingNoteId,
      warehouseId: inbound.warehouseId,
      itemCount: items.length,
    });
  });

  transaction();
  return loadInbound(inboundId) as InboundRecord;
}

export function forceUpdateInboundStatus(inboundId: string, nextStatus: string) {
  if (!ALLOWED_INBOUND_STATUSES.has(nextStatus)) {
    throw new Error('Unsupported inbound status');
  }

  const inbound = loadInbound(inboundId);
  if (!inbound) {
    throw new Error('Inbound order not found');
  }

  if (inbound.status === nextStatus) {
    return loadInbound(inboundId) as InboundRecord;
  }

  const now = new Date().toISOString();
  const today = currentDateString();

  const transaction = db.transaction(() => {
    if (inbound.status !== STATUS_INBOUND_DONE && nextStatus === STATUS_INBOUND_DONE) {
      applyInboundInventoryDelta(inbound.receivingNoteId, inbound.warehouseId, inboundId, 'in', now, 'force_inbound');
      db.prepare('UPDATE receiving_notes SET status = ? WHERE id = ?').run(STATUS_INBOUND_DONE, inbound.receivingNoteId);
      db.prepare('UPDATE inbound_orders SET status = ?, completed_at = ? WHERE id = ?').run(STATUS_INBOUND_DONE, today, inboundId);
    } else if (inbound.status === STATUS_INBOUND_DONE && nextStatus === STATUS_PENDING_INBOUND) {
      applyInboundInventoryDelta(inbound.receivingNoteId, inbound.warehouseId, inboundId, 'out', now, 'force_inbound_revert');
      db.prepare('UPDATE receiving_notes SET status = ? WHERE id = ?').run(STATUS_RECEIVING_PENDING_INBOUND, inbound.receivingNoteId);
      db.prepare('UPDATE inbound_orders SET status = ?, completed_at = NULL WHERE id = ?').run(STATUS_PENDING_INBOUND, inboundId);
    } else {
      db.prepare('UPDATE inbound_orders SET status = ? WHERE id = ?').run(nextStatus, inboundId);
    }

    recalculatePurchaseOrderStatus(inbound.purchaseOrderId);
    appendAuditLog('force_update_inbound_status', 'inbound_order', inboundId, {
      previousStatus: inbound.status,
      nextStatus,
    });
  });

  transaction();
  return loadInbound(inboundId) as InboundRecord;
}

export function deleteInbound(inboundId: string, options?: { aggressive?: boolean }) {
  const aggressive = Boolean(options?.aggressive);
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    throw new Error('Inbound order not found');
  }

  if (!aggressive && inbound.status === STATUS_INBOUND_DONE) {
    throw new Error('Inbound already confirmed. Enable aggressive delete to force rollback and delete.');
  }

  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    if (inbound.status === STATUS_INBOUND_DONE) {
      applyInboundInventoryDelta(inbound.receivingNoteId, inbound.warehouseId, inboundId, 'out', now, 'delete_inbound_reverse');
    }

    db.prepare('DELETE FROM inbound_orders WHERE id = ?').run(inboundId);
    db.prepare('UPDATE receiving_notes SET status = ? WHERE id = ?').run(STATUS_RECEIVING_PENDING_INBOUND, inbound.receivingNoteId);
    recalculatePurchaseOrderStatus(inbound.purchaseOrderId);

    appendAuditLog(aggressive ? 'delete_inbound_order_force' : 'delete_inbound_order', 'inbound_order', inboundId, {
      previousStatus: inbound.status,
      receivingNoteId: inbound.receivingNoteId,
      warehouseId: inbound.warehouseId,
      aggressive,
    });
  });

  transaction();
  return {
    id: inboundId,
    deleted: true,
  };
}