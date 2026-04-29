import { appendAuditLog, appendInventoryMovement, db, nextDocumentId } from '../../database/db';
import { currentDateString } from '../../shared/format';
import {
  allocateInboundAcrossShelves,
  allocateOutboundFromShelves,
  listWarehouseShelves,
  planInboundShelfAllocations,
  suggestShelfForProduct,
} from '../inventory/inventory-shelf.service';
import { recalculatePurchaseOrderStatus } from '../procurement/procurement-workflow.service';

const STATUS_PENDING_INBOUND = '\u5F85\u5165\u5E93';
const STATUS_INBOUND_DONE = '\u5DF2\u5165\u5E93';
const STATUS_RECEIVING_PENDING_INBOUND = '\u5DF2\u9A8C\u6536\u5F85\u5165\u5E93';
const STATUS_RECEIVING_DONE = '\u5DF2\u5165\u5E93';

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
  sourcePurchaseOrderIds?: string[];
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

export interface ManualInboundCandidateItem {
  supplierId: string;
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  supplier: string;
  expectedDate: string;
  procurementStatus: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
  remainingQty: number;
  unitCost: number;
}

export interface CreateManualInboundItemPayload {
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  arrivedQty: number;
}

export interface CreateManualInboundResult {
  inboundIds: string[];
  arrivalIds: string[];
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

interface ManualInboundCandidateRow extends ManualInboundCandidateItem {}
interface ManualInboundSourceRow {
  inboundId: string;
  receivingNoteId: string;
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  receivingNoteItemId: string;
  qualifiedQty: number;
  inboundQty: number;
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

function loadInboundByReceivingNote(receivingNoteId: string) {
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
    WHERE io.receiving_note_id = ?
  `).get(receivingNoteId);
}

function loadManualInboundCandidates() {
  return db.prepare<ManualInboundCandidateRow>(`
    SELECT
      po.supplier_id as supplierId,
      po.id as purchaseOrderId,
      poi.id as purchaseOrderItemId,
      s.name as supplier,
      po.expected_at as expectedDate,
      po.status as procurementStatus,
      p.id as productId,
      p.sku as sku,
      p.name as productName,
      poi.ordered_qty as orderedQty,
      poi.arrived_qty as arrivedQty,
      poi.unit_cost as unitCost,
      CASE WHEN poi.ordered_qty > poi.arrived_qty THEN poi.ordered_qty - poi.arrived_qty ELSE 0 END as remainingQty
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    JOIN suppliers s ON s.id = po.supplier_id
    JOIN products p ON p.id = poi.product_id
    WHERE po.status NOT IN ('宸插彇娑?, '宸插畬鎴?)
      AND poi.ordered_qty > poi.arrived_qty
    ORDER BY po.expected_at DESC, po.id DESC, poi.id ASC
  `).all();
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

function loadManualInboundCandidatesV2() {
  return db.prepare<ManualInboundCandidateRow>(`
    SELECT
      rn.supplier_id as supplierId,
      rn.purchase_order_id as purchaseOrderId,
      poi.id as purchaseOrderItemId,
      s.name as supplier,
      po.expected_at as expectedDate,
      po.status as procurementStatus,
      p.id as productId,
      p.sku as sku,
      p.name as productName,
      rni.expected_qty as orderedQty,
      rni.qualified_qty as arrivedQty,
      poi.unit_cost as unitCost,
      CASE WHEN rni.qualified_qty > rni.inbound_qty THEN rni.qualified_qty - rni.inbound_qty ELSE 0 END as remainingQty
    FROM inbound_orders io
    JOIN receiving_notes rn ON rn.id = io.receiving_note_id
    JOIN receiving_note_items rni ON rni.receiving_note_id = rn.id
    JOIN purchase_order_items poi ON poi.id = rni.purchase_order_item_id
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    JOIN suppliers s ON s.id = rn.supplier_id
    JOIN products p ON p.id = rni.product_id
    WHERE rn.status = ?
      AND io.status = ?
      AND rni.qualified_qty > rni.inbound_qty
    ORDER BY po.expected_at DESC, rn.purchase_order_id DESC, poi.id ASC
  `).all(STATUS_RECEIVING_PENDING_INBOUND, STATUS_PENDING_INBOUND);
}

function loadManualInboundSourcesV2() {
  return db.prepare<ManualInboundSourceRow>(`
    SELECT
      io.id as inboundId,
      rn.id as receivingNoteId,
      rn.purchase_order_id as purchaseOrderId,
      poi.id as purchaseOrderItemId,
      rni.id as receivingNoteItemId,
      rni.qualified_qty as qualifiedQty,
      rni.inbound_qty as inboundQty
    FROM inbound_orders io
    JOIN receiving_notes rn ON rn.id = io.receiving_note_id
    JOIN receiving_note_items rni ON rni.receiving_note_id = rn.id
    JOIN purchase_order_items poi ON poi.id = rni.purchase_order_item_id
    WHERE rn.status = ?
      AND io.status = ?
      AND rni.qualified_qty > rni.inbound_qty
  `).all(STATUS_RECEIVING_PENDING_INBOUND, STATUS_PENDING_INBOUND);
}

function normalizePendingInboundDrafts() {
  const rows = db.prepare<{
    inboundId: string;
    receivingNoteId: string;
    qualifiedQty: number;
    inboundQty: number;
    shelfId: string | null;
  }>(`
    SELECT
      io.id as inboundId,
      io.receiving_note_id as receivingNoteId,
      rni.qualified_qty as qualifiedQty,
      rni.inbound_qty as inboundQty,
      rni.shelf_id as shelfId
    FROM inbound_orders io
    JOIN receiving_notes rn ON rn.id = io.receiving_note_id
    JOIN receiving_note_items rni ON rni.receiving_note_id = rn.id
    WHERE io.status = ?
      AND rn.status = ?
    ORDER BY io.id ASC, rni.id ASC
  `).all(STATUS_PENDING_INBOUND, STATUS_RECEIVING_PENDING_INBOUND);

  if (rows.length === 0) {
    return;
  }

  const grouped = new Map<string, typeof rows>();
  rows.forEach((row) => {
    const current = grouped.get(row.inboundId) ?? [];
    current.push(row);
    grouped.set(row.inboundId, current);
  });

  const resetItem = db.prepare('UPDATE receiving_note_items SET inbound_qty = 0 WHERE receiving_note_id = ?');
  const resetInbound = db.prepare('UPDATE inbound_orders SET inbound_qty = 0 WHERE id = ?');

  const transaction = db.transaction(() => {
    grouped.forEach((items, inboundId) => {
      const hasShelfAssignment = items.some((item) => Boolean(item.shelfId));
      const hasArtificialFullInbound = items.length > 0 && items.every((item) => item.qualifiedQty > 0 && item.inboundQty >= item.qualifiedQty);
      if (hasShelfAssignment || !hasArtificialFullInbound) {
        return;
      }

      resetItem.run(items[0].receivingNoteId);
      resetInbound.run(inboundId);
    });
  });

  transaction();
}

function reserveAutoShelf(
  productId: string,
  warehouseId: string,
  requiredQty: number,
  remainingByWarehouse: Map<string, Map<string, number>>,
) {
  if (requiredQty <= 0) {
    return null;
  }

  let remainingMap = remainingByWarehouse.get(warehouseId);
  if (!remainingMap) {
    remainingMap = new Map(
      listWarehouseShelves(warehouseId).map((shelf) => [shelf.id, shelf.remainingCapacity]),
    );
    remainingByWarehouse.set(warehouseId, remainingMap);
  }

  const allocations = planInboundShelfAllocations(productId, warehouseId, requiredQty, null, remainingMap);
  return allocations[0]?.shelfId ?? null;
}

function reserveInboundShelf(
  productId: string,
  warehouseId: string,
  requiredQty: number,
  preferredShelfId: string | null | undefined,
  remainingByWarehouse: Map<string, Map<string, number>>,
) {
  if (requiredQty <= 0) {
    return null;
  }

  let remainingMap = remainingByWarehouse.get(warehouseId);
  if (!remainingMap) {
    remainingMap = new Map(
      listWarehouseShelves(warehouseId).map((shelf) => [shelf.id, shelf.remainingCapacity]),
    );
    remainingByWarehouse.set(warehouseId, remainingMap);
  }

  const allocations = planInboundShelfAllocations(productId, warehouseId, requiredQty, preferredShelfId, remainingMap);
  return allocations[0]?.shelfId ?? null;
}

function loadSourcePurchaseOrderIdsForReceivingNote(receivingNoteId: string) {
  return db
    .prepare<{ purchaseOrderId: string }>(`
      SELECT DISTINCT poi.purchase_order_id as purchaseOrderId
      FROM receiving_note_items rni
      JOIN purchase_order_items poi ON poi.id = rni.purchase_order_item_id
      WHERE rni.receiving_note_id = ?
      ORDER BY poi.purchase_order_id ASC
    `)
    .all(receivingNoteId)
    .map((item) => item.purchaseOrderId);
}

function refreshSourceInboundAfterFlow(inboundId: string) {
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    return;
  }

  const totals =
    db.prepare<{ qualifiedQty: number; inboundQty: number }>(`
      SELECT
        COALESCE(SUM(qualified_qty), 0) as qualifiedQty,
        COALESCE(SUM(inbound_qty), 0) as inboundQty
      FROM receiving_note_items
      WHERE receiving_note_id = ?
    `).get(inbound.receivingNoteId) ?? { qualifiedQty: 0, inboundQty: 0 };

  const nextStatus =
    totals.qualifiedQty > 0 && totals.inboundQty >= totals.qualifiedQty
      ? STATUS_INBOUND_DONE
      : STATUS_PENDING_INBOUND;
  const today = currentDateString();

  db.prepare('UPDATE inbound_orders SET inbound_qty = ?, status = ?, completed_at = ? WHERE id = ?').run(
    totals.inboundQty,
    nextStatus,
    nextStatus === STATUS_INBOUND_DONE ? today : null,
    inboundId,
  );
  db.prepare('UPDATE receiving_notes SET status = ? WHERE id = ?').run(
    nextStatus === STATUS_INBOUND_DONE ? STATUS_RECEIVING_DONE : STATUS_RECEIVING_PENDING_INBOUND,
    inbound.receivingNoteId,
  );
  loadSourcePurchaseOrderIdsForReceivingNote(inbound.receivingNoteId).forEach((purchaseOrderId) => {
    recalculatePurchaseOrderStatus(purchaseOrderId);
  });
}

function normalizeInboundDraftItems(inbound: InboundRow, payloadItems: SaveInboundDraftItemPayload[]) {
  const currentItems = loadInboundItemStocks(inbound.receivingNoteId);
  const itemMap = new Map(currentItems.map((item) => [item.id, item]));
  const shelfMap = new Map(listWarehouseShelves(inbound.warehouseId).map((item) => [item.id, item]));
  const remainingByWarehouse = new Map<string, Map<string, number>>();
  const initialRemaining = new Map(
    listWarehouseShelves(inbound.warehouseId).map((shelf) => [shelf.id, shelf.remainingCapacity]),
  );
  currentItems.forEach((item) => {
    if (item.shelfId && item.inboundQty > 0) {
      initialRemaining.set(item.shelfId, (initialRemaining.get(item.shelfId) ?? 0) + item.inboundQty);
    }
  });
  remainingByWarehouse.set(inbound.warehouseId, initialRemaining);

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

    const assignedShelfId =
      payloadItem.inboundQty > 0
        ? reserveInboundShelf(
            currentItem.productId,
            inbound.warehouseId,
            payloadItem.inboundQty,
            payloadItem.shelfId || currentItem.shelfId,
            remainingByWarehouse,
          )
        : null;
    const shelf = assignedShelfId ? shelfMap.get(assignedShelfId) : undefined;

    return {
      ...currentItem,
      qualifiedQty: payloadItem.qualifiedQty,
      defectQty: Math.max(currentItem.arrivedQty - payloadItem.qualifiedQty, 0),
      inboundQty: payloadItem.inboundQty,
      shelfId: assignedShelfId,
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
  normalizePendingInboundDrafts();
  return loadInboundRows();
}

export function listManualInboundCandidateItems() {
  normalizePendingInboundDrafts();
  return loadManualInboundCandidatesV2();
}

export function getInboundDetail(inboundId: string): InboundDetailRecord | null {
  normalizePendingInboundDrafts();
  const inbound = loadInbound(inboundId);
  if (!inbound) {
    return null;
  }

  const items = loadInboundItemStocks(inbound.receivingNoteId);
  const sourcePurchaseOrderIds = db
    .prepare<{ purchaseOrderId: string }>(`
      SELECT DISTINCT poi.purchase_order_id as purchaseOrderId
      FROM receiving_note_items rni
      JOIN purchase_order_items poi ON poi.id = rni.purchase_order_item_id
      WHERE rni.receiving_note_id = ?
      ORDER BY poi.purchase_order_id ASC
    `)
    .all(inbound.receivingNoteId)
    .map((item) => item.purchaseOrderId);
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
    sourcePurchaseOrderIds,
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

    db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(qtyAfter, item.productId, warehouseId);
    const allocations =
      direction === 'in'
        ? allocateInboundAcrossShelves(item.productId, warehouseId, item.inboundQty, item.shelfId)
        : allocateOutboundFromShelves(item.productId, warehouseId, item.inboundQty);
    const shelfSummary = allocations.map((allocation) => `${allocation.shelfId}:${allocation.quantity}`).join(', ');

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
      remark: `${remarkPrefix} ${receivingNoteId} / ${shelfSummary || item.shelfId || 'no-shelf'}`,
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
    loadSourcePurchaseOrderIdsForReceivingNote(inbound.receivingNoteId).forEach((purchaseOrderId) => {
      recalculatePurchaseOrderStatus(purchaseOrderId);
    });

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

    loadSourcePurchaseOrderIdsForReceivingNote(inbound.receivingNoteId).forEach((purchaseOrderId) => {
      recalculatePurchaseOrderStatus(purchaseOrderId);
    });
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

export function createManualInboundOrders(payloadItems: CreateManualInboundItemPayload[]): CreateManualInboundResult {
  if (!Array.isArray(payloadItems) || payloadItems.length === 0) {
    throw new Error('请选择至少一条商品明细。');
  }

  const availableItems = listManualInboundCandidateItems();
  const availableMap = new Map(
    availableItems.map((item) => [`${item.purchaseOrderId}::${item.purchaseOrderItemId}`, item]),
  );
  const sourceMap = new Map(
    loadManualInboundSourcesV2().map((item) => [`${item.purchaseOrderId}::${item.purchaseOrderItemId}`, item]),
  );
  const selectedItems: Array<ManualInboundCandidateItem & { inboundQty: number; source: ManualInboundSourceRow }> = [];
  const selectedKeys = new Set<string>();
  const shelfRemainingByWarehouse = new Map<string, Map<string, number>>();

  payloadItems.forEach((item, index) => {
    const purchaseOrderId = String(item.purchaseOrderId || '').trim();
    const purchaseOrderItemId = String(item.purchaseOrderItemId || '').trim();
    const inboundQty = Number(item.arrivedQty);
    const key = `${purchaseOrderId}::${purchaseOrderItemId}`;
    if (!purchaseOrderId || !purchaseOrderItemId) {
      throw new Error(`第 ${index + 1} 行缺少采购单号或商品明细。`);
    }
    if (!Number.isInteger(inboundQty) || inboundQty <= 0) {
      throw new Error(`第 ${index + 1} 行入库数量必须为正整数。`);
    }
    if (selectedKeys.has(key)) {
      throw new Error(`采购明细 ${purchaseOrderItemId} 被重复选择。`);
    }

    const available = availableMap.get(key);
    const source = sourceMap.get(key);
    if (!available || !source) {
      throw new Error(`采购明细 ${purchaseOrderItemId} 当前不可用于创建入库单。`);
    }
    if (inboundQty > available.remainingQty) {
      throw new Error(`${available.sku} 的本次入库数量不能超过未入库数量 ${available.remainingQty}。`);
    }

    selectedKeys.add(key);
    selectedItems.push({ ...available, inboundQty, source });
  });

  if (selectedItems.length === 0) {
    throw new Error('请选择至少一条待入库明细。');
  }

  const today = currentDateString();
  let targetArrivalId = '';
  let targetInboundId = '';

  const transaction = db.transaction(() => {
    const firstItem = selectedItems[0];
    const firstSourceInbound = loadInbound(firstItem.source.inboundId);
    if (!firstSourceInbound) {
      throw new Error(`入库单 ${firstItem.source.inboundId} 不存在。`);
    }

    const totalInboundQty = selectedItems.reduce((sum, item) => sum + item.inboundQty, 0);
    targetArrivalId = nextDocumentId('receiving_notes', 'RCV', today);
    targetInboundId = nextDocumentId('inbound_orders', 'INB', today);

    db.prepare(
      'INSERT INTO receiving_notes (id, purchase_order_id, supplier_id, expected_qty, arrived_qty, qualified_qty, defect_qty, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      targetArrivalId,
      firstItem.purchaseOrderId,
      firstItem.supplierId,
      totalInboundQty,
      totalInboundQty,
      totalInboundQty,
      0,
      STATUS_RECEIVING_PENDING_INBOUND,
      today,
    );

    db.prepare(
      'INSERT INTO inbound_orders (id, receiving_note_id, warehouse_id, inbound_qty, status, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(targetInboundId, targetArrivalId, firstSourceInbound.warehouseId, totalInboundQty, STATUS_PENDING_INBOUND, null);

    const insertTargetItem = db.prepare(
      'INSERT INTO receiving_note_items (id, receiving_note_id, purchase_order_item_id, product_id, expected_qty, arrived_qty, qualified_qty, defect_qty, inbound_qty, shelf_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const affectedSourceInboundIds = new Set<string>();

    selectedItems.forEach((item, index) => {
      const sourceInbound = loadInbound(item.source.inboundId);
      if (!sourceInbound) {
        throw new Error(`入库单 ${item.source.inboundId} 不存在。`);
      }
      const shelfId = reserveAutoShelf(
        item.productId,
        firstSourceInbound.warehouseId,
        item.inboundQty,
        shelfRemainingByWarehouse,
      );
      if (!shelfId) {
        throw new Error(`没有可用货架可容纳 ${item.sku} 的入库数量 ${item.inboundQty}。`);
      }

      db.prepare('UPDATE receiving_note_items SET inbound_qty = ? WHERE id = ?').run(
        item.source.inboundQty + item.inboundQty,
        item.source.receivingNoteItemId,
      );
      insertTargetItem.run(
        `${targetArrivalId}-ITEM-${index + 1}`,
        targetArrivalId,
        item.purchaseOrderItemId,
        item.productId,
        item.inboundQty,
        item.inboundQty,
        item.inboundQty,
        0,
        item.inboundQty,
        shelfId,
      );
      affectedSourceInboundIds.add(item.source.inboundId);
    });

    affectedSourceInboundIds.forEach((inboundId) => refreshSourceInboundAfterFlow(inboundId));

    appendAuditLog('create_manual_inbound_orders', 'inbound_order', targetInboundId, {
      inboundIds: [targetInboundId],
      arrivalIds: [targetArrivalId],
      sourceInboundIds: Array.from(affectedSourceInboundIds),
      sourceArrivalIds: Array.from(affectedSourceInboundIds).map((inboundId) => loadInbound(inboundId)?.receivingNoteId).filter(Boolean),
      purchaseOrderCount: new Set(selectedItems.map((item) => item.purchaseOrderId)).size,
      itemCount: selectedItems.length,
    });
  });

  transaction();

  const confirmedInboundId = confirmInbound(targetInboundId).id;
  const arrivalId = loadInbound(confirmedInboundId)?.receivingNoteId ?? targetArrivalId;

  return {
    inboundIds: [confirmedInboundId],
    arrivalIds: [arrivalId],
  };
}
