import { appendAuditLog, appendInventoryMovement, db, nextDocumentId } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { listWarehouseShelves, suggestShelfForProduct, updateShelfStock } from '../inventory/inventory-shelf.service';
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
  warehouseId: string;
  completedAt?: string;
  shelfOptions: InboundShelfOption[];
  itemsDetail: InboundDetailItem[];
}

export interface InboundShelfOption {
  id: string;
  shelfCode: string;
  shelfName: string;
  tags: string[];
  capacity: number;
  usedQuantity: number;
  remainingCapacity: number;
}

export interface InboundDetailItem {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
  inboundQty: number;
  shelfId?: string;
  shelfCode?: string;
  shelfName?: string;
  suggestedShelfId?: string;
  suggestedShelfCode?: string;
}

export interface SaveInboundDraftItemPayload {
  itemId: string;
  qualifiedQty: number;
  inboundQty: number;
  shelfId: string;
}

interface InboundRow extends InboundRecord {
  receivingNoteId: string;
  purchaseOrderId: string;
  completedAt: string | null;
  warehouseId: string;
}

interface InboundItemRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
  inboundQty: number;
  shelfId: string | null;
  shelfCode: string | null;
  shelfName: string | null;
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
      rni.id,
      rni.product_id as productId,
      p.sku as sku,
      p.name as productName,
      rni.expected_qty as expectedQty,
      rni.arrived_qty as arrivedQty,
      rni.qualified_qty as qualifiedQty,
      rni.defect_qty as defectQty,
      rni.inbound_qty as inboundQty,
      rni.shelf_id as shelfId,
      ws.shelf_code as shelfCode,
      ws.shelf_name as shelfName
    FROM receiving_note_items rni
    JOIN products p ON p.id = rni.product_id
    LEFT JOIN warehouse_shelves ws ON ws.id = rni.shelf_id
    WHERE rni.receiving_note_id = ?
    ORDER BY rni.id ASC
  `).all(receivingNoteId);
}

function normalizeInboundDraftItems(inbound: InboundRow, payloadItems: SaveInboundDraftItemPayload[]) {
  const currentItems = loadInboundItemStocks(inbound.receivingNoteId);
  const itemMap = new Map(currentItems.map((item) => [item.id, item]));
  const shelfMap = new Map(listWarehouseShelves(inbound.warehouseId).map((item) => [item.id, item]));

  if (payloadItems.length !== currentItems.length) {
    throw new Error('Inbound draft item count mismatch');
  }

  return payloadItems.map((payloadItem) => {
    const currentItem = itemMap.get(payloadItem.itemId);
    if (!currentItem) {
      throw new Error('Inbound draft item not found');
    }

    if (!Number.isInteger(payloadItem.qualifiedQty) || payloadItem.qualifiedQty < 0 || payloadItem.qualifiedQty > currentItem.arrivedQty) {
      throw new Error(`Qualified quantity is invalid for ${currentItem.sku}`);
    }

    if (!Number.isInteger(payloadItem.inboundQty) || payloadItem.inboundQty < 0 || payloadItem.inboundQty > payloadItem.qualifiedQty) {
      throw new Error(`Inbound quantity is invalid for ${currentItem.sku}`);
    }

    const shelf = shelfMap.get(payloadItem.shelfId);
    if (!shelf && payloadItem.inboundQty > 0) {
      throw new Error(`Shelf is required for ${currentItem.sku}`);
    }

    if (shelf && payloadItem.inboundQty > 0) {
      const currentAssignedQty = currentItem.shelfId === shelf.id ? currentItem.inboundQty : 0;
      const netIncrease = Math.max(payloadItem.inboundQty - currentAssignedQty, 0);
      if (shelf.remainingCapacity < netIncrease) {
        throw new Error(`Shelf ${shelf.shelfCode} capacity is insufficient for ${currentItem.sku}`);
      }
    }

    return {
      ...currentItem,
      qualifiedQty: payloadItem.qualifiedQty,
      defectQty: Math.max(currentItem.arrivedQty - payloadItem.qualifiedQty, 0),
      inboundQty: payloadItem.inboundQty,
      shelfId: payloadItem.inboundQty > 0 ? payloadItem.shelfId : null,
      shelfCode: shelf?.shelfCode ?? null,
      shelfName: shelf?.shelfName ?? null,
    };
  });
}

function persistInboundDraft(inbound: InboundRow, payloadItems: SaveInboundDraftItemPayload[]) {
  if (inbound.status === STATUS_INBOUND_DONE) {
    throw new Error('Inbound order is already confirmed');
  }

  const normalizedItems = normalizeInboundDraftItems(inbound, payloadItems);
  const updateItem = db.prepare(
    'UPDATE receiving_note_items SET qualified_qty = ?, defect_qty = ?, inbound_qty = ?, shelf_id = ? WHERE id = ?',
  );
  const totalQualifiedQty = normalizedItems.reduce((sum, item) => sum + item.qualifiedQty, 0);
  const totalDefectQty = normalizedItems.reduce((sum, item) => sum + item.defectQty, 0);
  const totalInboundQty = normalizedItems.reduce((sum, item) => sum + item.inboundQty, 0);

  normalizedItems.forEach((item) => {
    updateItem.run(item.qualifiedQty, item.defectQty, item.inboundQty, item.shelfId, item.id);
  });

  db.prepare(
    'UPDATE receiving_notes SET qualified_qty = ?, defect_qty = ?, status = ? WHERE id = ?',
  ).run(totalQualifiedQty, totalDefectQty, STATUS_RECEIVING_PENDING_INBOUND, inbound.receivingNoteId);
  db.prepare('UPDATE inbound_orders SET inbound_qty = ? WHERE id = ?').run(totalInboundQty, inbound.id);

  appendAuditLog('save_inbound_draft', 'inbound_order', inbound.id, {
    receivingNoteId: inbound.receivingNoteId,
    itemCount: normalizedItems.length,
    inboundQty: totalInboundQty,
  });

  return normalizedItems;
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
  const shelfOptions = listWarehouseShelves(inbound.warehouseId).map((shelf) => ({
    id: shelf.id,
    shelfCode: shelf.shelfCode,
    shelfName: shelf.shelfName,
    tags: shelf.tags,
    capacity: shelf.capacity,
    usedQuantity: shelf.usedQuantity,
    remainingCapacity: shelf.remainingCapacity,
  }));

  return {
    id: inbound.id,
    rcvId: inbound.rcvId,
    poId: inbound.purchaseOrderId,
    supplier: inbound.supplier,
    warehouseId: inbound.warehouseId,
    items: inbound.items,
    warehouse: inbound.warehouse,
    status: inbound.status,
    completedAt: inbound.completedAt ?? undefined,
    shelfOptions,
    itemsDetail: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.sku,
      productName: item.productName,
      expectedQty: item.expectedQty,
      arrivedQty: item.arrivedQty,
      qualifiedQty: item.qualifiedQty,
      defectQty: item.defectQty,
      inboundQty: item.inboundQty,
      shelfId: item.shelfId ?? undefined,
      shelfCode: item.shelfCode ?? undefined,
      shelfName: item.shelfName ?? undefined,
      suggestedShelfId: suggestShelfForProduct(item.productId, inbound.warehouseId)?.id,
      suggestedShelfCode: suggestShelfForProduct(item.productId, inbound.warehouseId)?.shelfCode,
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
    .prepare<{ productId: string; inboundQty: number; shelfId: string | null }>(
      'SELECT product_id as productId, inbound_qty as inboundQty, shelf_id as shelfId FROM receiving_note_items WHERE receiving_note_id = ?',
    )
    .all(receivingNoteId);

  items.forEach((item) => {
    if (item.inboundQty <= 0) {
      return;
    }

    if (!item.shelfId) {
      throw new Error(`Shelf is missing for inbound item ${item.productId}`);
    }

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
    const qtyAfter = direction === 'in' ? qtyBefore + item.inboundQty : qtyBefore - item.inboundQty;
    if (qtyAfter < 0) {
      throw new Error(`Inventory inconsistency for product ${item.productId}: current=${qtyBefore}, delta=${item.inboundQty}`);
    }

    db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
      qtyAfter,
      item.productId,
      warehouseId,
    );
    updateShelfStock(item.productId, warehouseId, item.shelfId, direction === 'in' ? item.inboundQty : -item.inboundQty);

    appendInventoryMovement({
      productId: item.productId,
      warehouseId,
      movementType: direction === 'in' ? 'inbound' : 'reverse',
      sourceType: 'inbound_order',
      sourceId,
      qtyChange: direction === 'in' ? item.inboundQty : -item.inboundQty,
      reservedChange: 0,
      qtyBefore,
      qtyAfter,
      reservedBefore: stock.reservedStock,
      reservedAfter: stock.reservedStock,
      occurredAt,
      remark: `${remarkPrefix} ${receivingNoteId} / ${item.shelfId}`,
    });
  });
}

export function saveInboundDraft(inboundId: string, payloadItems: SaveInboundDraftItemPayload[]) {
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    throw new Error('Inbound order not found');
  }

  const transaction = db.transaction(() => {
    persistInboundDraft(inbound, payloadItems);
  });

  transaction();
  return getInboundDetail(inboundId) as InboundDetailRecord;
}

export function confirmInbound(inboundId: string, payloadItems?: SaveInboundDraftItemPayload[]) {
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    throw new Error('Inbound order not found');
  }

  if (inbound.status === STATUS_INBOUND_DONE) {
    return inbound;
  }

  const today = currentDateString();
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    if (payloadItems && payloadItems.length > 0) {
      persistInboundDraft(inbound, payloadItems);
    }

    const items = loadInboundItemStocks(inbound.receivingNoteId);
    const totalInboundQty = items.reduce((sum, item) => sum + item.inboundQty, 0);
    if (totalInboundQty <= 0) {
      throw new Error('Inbound quantity must be greater than 0');
    }

    applyInboundInventoryDelta(inbound.receivingNoteId, inbound.warehouseId, inboundId, 'in', now, 'inbound_confirm');

    db.prepare('UPDATE inbound_orders SET status = ?, completed_at = ? WHERE id = ?').run(STATUS_INBOUND_DONE, today, inboundId);
    db.prepare('UPDATE receiving_notes SET status = ? WHERE id = ?').run(STATUS_INBOUND_DONE, inbound.receivingNoteId);
    recalculatePurchaseOrderStatus(inbound.purchaseOrderId);

    appendAuditLog('confirm_inbound', 'inbound_order', inboundId, {
      receivingNoteId: inbound.receivingNoteId,
      warehouseId: inbound.warehouseId,
      itemCount: items.length,
      inboundQty: totalInboundQty,
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
