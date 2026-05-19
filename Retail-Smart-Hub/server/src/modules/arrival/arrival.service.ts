import { db, appendAuditLog, nextDocumentId } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';
import { recalculatePurchaseOrderStatus } from '../procurement/procurement-workflow.service';

export interface ArrivalRecord {
  id: string;
  poId: string;
  supplier: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
  status: string;
}

export interface ArrivalDetailRecord extends ArrivalRecord {
  arrivedAt: string;
  sourcePurchaseOrderIds?: string[];
  items: Array<{
    id: string;
    sku: string;
    productName: string;
    expectedQty: number;
    arrivedQty: number;
    qualifiedQty: number;
    defectQty: number;
  }>;
}

export interface ManualArrivalCandidateItem {
  arrivalId?: string;
  purchaseOrderId: string;
  supplierId: string;
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

export interface CreateManualArrivalItemPayload {
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  arrivedQty: number;
}

export interface CreateManualArrivalResult {
  arrivalIds: string[];
}

export interface ProcurementArrivalWorkspaceItem {
  itemId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
  remainingQty: number;
}

export interface ProcurementArrivalWorkspaceRecord {
  purchaseOrderId: string;
  arrivalId?: string;
  supplier: string;
  expectedDate: string;
  procurementStatus: string;
  arrivalStatus?: string;
  arrivedAt?: string;
  editable: boolean;
  items: ProcurementArrivalWorkspaceItem[];
  totalOrderedQty: number;
  totalArrivedQty: number;
  totalRemainingQty: number;
}

export interface RegisterProcurementArrivalItemPayload {
  itemId: string;
  arrivedQty: number;
}

export interface RegisterProcurementArrivalPayload {
  items: RegisterProcurementArrivalItemPayload[];
}

export interface ForceUpdateArrivalLineItemPayload {
  itemId: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
}

export interface ForceUpdateArrivalLinesPayload {
  reason?: string;
  items: ForceUpdateArrivalLineItemPayload[];
}

interface ArrivalRow extends ArrivalRecord {
  supplierId: string;
  arrivedAt: string;
}

interface ArrivalItemRow {
  id: string;
  purchaseOrderItemId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
}

interface ProcurementArrivalPurchaseOrderRow {
  id: string;
  supplierId: string;
  supplier: string;
  expectedDate: string;
  status: string;
}

interface ProcurementArrivalPurchaseOrderItemRow {
  itemId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
}

interface ManualArrivalCandidateRow extends ManualArrivalCandidateItem {}

const PROCUREMENT_STATUS_ARRIVED = '到货';
const LEGACY_PROCUREMENT_STATUS_PARTIAL = '部分到货';
const ARRIVAL_STATUS_PENDING = '待验收';
const ARRIVAL_STATUS_PENDING_INBOUND = '已验收待入库';
const ARRIVAL_STATUS_INBOUND_DONE = '已入库';
const MIXED_SUPPLIER_ID = 'SUP-MIXED';
const MIXED_SUPPLIER_NAME = '多供应商';

function normalizeProcurementStatus(status: string) {
  return status === LEGACY_PROCUREMENT_STATUS_PARTIAL ? PROCUREMENT_STATUS_ARRIVED : status;
}

function ensureMixedSupplierExists() {
  db.prepare(
    'INSERT OR IGNORE INTO suppliers (id, name, contact_name, phone, lead_time_days, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(MIXED_SUPPLIER_ID, MIXED_SUPPLIER_NAME, '', '', 0, 'inactive');
}

function normalizeLegacyArrivalStates() {
  const legacyRows = db.prepare<{ id: string; arrivedQty: number; defectQty: number; status: string }>(`
    SELECT
      id,
      arrived_qty as arrivedQty,
      defect_qty as defectQty,
      status
    FROM receiving_notes
    WHERE status IN (?, ?)
  `).all(ARRIVAL_STATUS_PENDING, LEGACY_PROCUREMENT_STATUS_PARTIAL);

  if (legacyRows.length === 0) {
    return;
  }

  const updateReceivingNote = db.prepare(
    'UPDATE receiving_notes SET qualified_qty = ?, status = ? WHERE id = ?',
  );
  const updateReceivingItem = db.prepare(
    'UPDATE receiving_note_items SET qualified_qty = ? WHERE id = ?',
  );
  const sumQualified = db.prepare<{ total: number }>(
    'SELECT COALESCE(SUM(qualified_qty), 0) as total FROM receiving_note_items WHERE receiving_note_id = ?',
  );

  const transaction = db.transaction(() => {
    legacyRows.forEach((row) => {
      const items = loadArrivalItems(row.id);
      const qualifiedQty = Math.max(row.arrivedQty - row.defectQty, 0);

      items.forEach((item) => {
        updateReceivingItem.run(Math.max(item.arrivedQty - item.defectQty, 0), item.id);
      });

      updateReceivingNote.run(qualifiedQty, ARRIVAL_STATUS_PENDING, row.id);
      db.prepare('DELETE FROM inbound_orders WHERE receiving_note_id = ? AND status <> ?').run(row.id, ARRIVAL_STATUS_INBOUND_DONE);
      recalculatePurchaseOrdersForReceivingNote(row.id);
    });
  });

  transaction();
}

function normalizePendingArrivalCandidates() {
  const rows = db.prepare<{
    id: string;
    arrivedQty: number;
    qualifiedQty: number;
    inboundCount: number;
  }>(`
    SELECT
      rn.id,
      rn.arrived_qty as arrivedQty,
      rn.qualified_qty as qualifiedQty,
      COUNT(io.id) as inboundCount
    FROM receiving_notes rn
    LEFT JOIN inbound_orders io ON io.receiving_note_id = rn.id
    WHERE rn.status = ?
    GROUP BY rn.id, rn.arrived_qty, rn.qualified_qty
  `).all(ARRIVAL_STATUS_PENDING);

  if (rows.length === 0) {
    return;
  }

  const resetNote = db.prepare(
    'UPDATE receiving_notes SET qualified_qty = 0, defect_qty = 0 WHERE id = ?',
  );
  const resetItems = db.prepare(
    'UPDATE receiving_note_items SET qualified_qty = 0, defect_qty = 0 WHERE receiving_note_id = ?',
  );

  const transaction = db.transaction(() => {
    rows.forEach((row) => {
      if (row.qualifiedQty <= 0) {
        return;
      }

      if (row.inboundCount > 0) {
        refreshReceivingNoteProgress(row.id);
        return;
      }

      resetNote.run(row.id);
      resetItems.run(row.id);
    });
  });

  transaction();
}

export function listArrivals() {
  normalizeLegacyArrivalStates();
  normalizePendingArrivalCandidates();
  return db.prepare<ArrivalRow>(`
    SELECT
      rn.id,
      rn.purchase_order_id as poId,
      s.name as supplier,
      rn.supplier_id as supplierId,
      rn.expected_qty as expectedQty,
      rn.arrived_qty as arrivedQty,
      rn.qualified_qty as qualifiedQty,
      rn.defect_qty as defectQty,
      rn.status,
      rn.arrived_at as arrivedAt
    FROM receiving_notes rn
    JOIN suppliers s ON s.id = rn.supplier_id
    ORDER BY rn.arrived_at DESC, rn.id DESC
  `).all();
}

function loadArrival(id: string) {
  return db.prepare<ArrivalRow>(`
    SELECT
      rn.id,
      rn.purchase_order_id as poId,
      s.name as supplier,
      rn.supplier_id as supplierId,
      rn.expected_qty as expectedQty,
      rn.arrived_qty as arrivedQty,
      rn.qualified_qty as qualifiedQty,
      rn.defect_qty as defectQty,
      rn.status,
      rn.arrived_at as arrivedAt
    FROM receiving_notes rn
    JOIN suppliers s ON s.id = rn.supplier_id
    WHERE rn.id = ?
  `).get(id);
}

function loadArrivalItems(arrivalId: string) {
  return db.prepare<ArrivalItemRow>(`
    SELECT
      receiving_note_items.id as id,
      receiving_note_items.purchase_order_item_id as purchaseOrderItemId,
      p.sku as sku,
      p.name as productName,
      receiving_note_items.expected_qty as expectedQty,
      receiving_note_items.arrived_qty as arrivedQty,
      receiving_note_items.qualified_qty as qualifiedQty,
      receiving_note_items.defect_qty as defectQty
    FROM receiving_note_items
    JOIN products p ON p.id = receiving_note_items.product_id
    WHERE receiving_note_id = ?
    ORDER BY receiving_note_items.id ASC
  `).all(arrivalId);
}

function loadPurchaseOrderForArrival(poId: string) {
  return db.prepare<ProcurementArrivalPurchaseOrderRow>(`
    SELECT
      po.id,
      po.supplier_id as supplierId,
      s.name as supplier,
      po.expected_at as expectedDate,
      po.status
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = ?
  `).get(poId);
}

function loadPurchaseOrderItemsForArrival(poId: string) {
  return db.prepare<ProcurementArrivalPurchaseOrderItemRow>(`
    SELECT
      poi.id as itemId,
      p.sku as sku,
      p.name as productName,
      poi.ordered_qty as orderedQty,
      poi.arrived_qty as arrivedQty
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ?
    ORDER BY poi.id ASC
  `).all(poId);
}

function loadArrivalByPurchaseOrder(poId: string) {
  return db.prepare<ArrivalRow>(`
    SELECT
      rn.id,
      rn.purchase_order_id as poId,
      s.name as supplier,
      rn.supplier_id as supplierId,
      rn.expected_qty as expectedQty,
      rn.arrived_qty as arrivedQty,
      rn.qualified_qty as qualifiedQty,
      rn.defect_qty as defectQty,
      rn.status,
      rn.arrived_at as arrivedAt
    FROM receiving_notes rn
    JOIN suppliers s ON s.id = rn.supplier_id
    WHERE rn.purchase_order_id = ?
    ORDER BY rn.arrived_at DESC, rn.id DESC
    LIMIT 1
  `).get(poId);
}

function loadManualArrivalCandidates() {
  return db.prepare<ManualArrivalCandidateRow>(`
    SELECT
      rn.id as arrivalId,
      po.id as purchaseOrderId,
      rn.supplier_id as supplierId,
      rni.purchase_order_item_id as purchaseOrderItemId,
      supplier.name as supplier,
      po.expected_at as expectedDate,
      po.status as procurementStatus,
      rni.product_id as productId,
      product.sku as sku,
      product.name as productName,
      rni.expected_qty as orderedQty,
      rni.arrived_qty as arrivedQty,
      poi.unit_cost as unitCost,
      CASE
        WHEN rni.arrived_qty > rni.qualified_qty THEN rni.arrived_qty - rni.qualified_qty
        ELSE 0
      END as remainingQty
    FROM receiving_notes rn
    JOIN purchase_orders po ON po.id = rn.purchase_order_id
    JOIN suppliers supplier ON supplier.id = rn.supplier_id
    JOIN receiving_note_items rni ON rni.receiving_note_id = rn.id
    JOIN purchase_order_items poi ON poi.id = rni.purchase_order_item_id
    JOIN products product ON product.id = rni.product_id
    WHERE rn.status = ?
      AND rni.arrived_qty > rni.qualified_qty
    ORDER BY po.expected_at DESC, po.id DESC, rni.id ASC
  `).all(ARRIVAL_STATUS_PENDING);
}

function refreshReceivingNoteProgress(receivingNoteId: string) {
  const totals =
    db.prepare<{ arrivedQty: number; qualifiedQty: number; expectedQty: number }>(`
      SELECT
        COALESCE(SUM(expected_qty), 0) as expectedQty,
        COALESCE(SUM(arrived_qty), 0) as arrivedQty,
        COALESCE(SUM(qualified_qty), 0) as qualifiedQty
      FROM receiving_note_items
      WHERE receiving_note_id = ?
    `).get(receivingNoteId) ?? { expectedQty: 0, arrivedQty: 0, qualifiedQty: 0 };

  if (totals.qualifiedQty >= totals.arrivedQty && totals.arrivedQty > 0) {
    db.prepare(
      'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = 0, status = ? WHERE id = ?',
    ).run(totals.expectedQty, totals.arrivedQty, totals.qualifiedQty, ARRIVAL_STATUS_PENDING_INBOUND, receivingNoteId);
    upsertInbound(receivingNoteId, totals.qualifiedQty);
  } else {
    db.prepare(
      'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = 0, status = ? WHERE id = ?',
    ).run(totals.expectedQty, totals.arrivedQty, totals.qualifiedQty, ARRIVAL_STATUS_PENDING, receivingNoteId);
    db.prepare('DELETE FROM inbound_orders WHERE receiving_note_id = ? AND status <> ?').run(receivingNoteId, ARRIVAL_STATUS_INBOUND_DONE);
  }

  recalculatePurchaseOrdersForReceivingNote(receivingNoteId);
}

function refreshSourceReceivingNoteAfterAcceptanceFlow(receivingNoteId: string) {
  const totals =
    db.prepare<{ arrivedQty: number; qualifiedQty: number; expectedQty: number }>(`
      SELECT
        COALESCE(SUM(expected_qty), 0) as expectedQty,
        COALESCE(SUM(arrived_qty), 0) as arrivedQty,
        COALESCE(SUM(qualified_qty), 0) as qualifiedQty
      FROM receiving_note_items
      WHERE receiving_note_id = ?
    `).get(receivingNoteId) ?? { expectedQty: 0, arrivedQty: 0, qualifiedQty: 0 };

  const nextStatus =
    totals.arrivedQty > 0 && totals.qualifiedQty >= totals.arrivedQty
      ? ARRIVAL_STATUS_PENDING_INBOUND
      : ARRIVAL_STATUS_PENDING;

  db.prepare(
    'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = 0, status = ? WHERE id = ?',
  ).run(totals.expectedQty, totals.arrivedQty, totals.qualifiedQty, nextStatus, receivingNoteId);
  db.prepare('DELETE FROM inbound_orders WHERE receiving_note_id = ? AND status <> ?').run(receivingNoteId, ARRIVAL_STATUS_INBOUND_DONE);
  recalculatePurchaseOrdersForReceivingNote(receivingNoteId);
}

export function listManualArrivalCandidateItems() {
  normalizeLegacyArrivalStates();
  normalizePendingArrivalCandidates();
  return loadManualArrivalCandidates().filter((item) => item.remainingQty > 0);
}

function createAcceptanceFromPendingArrivals(payloadItems: CreateManualArrivalItemPayload[]): CreateManualArrivalResult {
  const availableItems = listManualArrivalCandidateItems();
  const availableMap = new Map(
    availableItems.map((item) => [`${item.purchaseOrderId}::${item.purchaseOrderItemId}`, item]),
  );
  const selectedItems: Array<ManualArrivalCandidateItem & { acceptedQty: number; arrivalId: string }> = [];
  const selectedKeys = new Set<string>();

  payloadItems.forEach((item, index) => {
    const purchaseOrderId = String(item.purchaseOrderId || '').trim();
    const purchaseOrderItemId = String(item.purchaseOrderItemId || '').trim();
    const acceptedQty = Number(item.arrivedQty);
    const key = `${purchaseOrderId}::${purchaseOrderItemId}`;

    if (!purchaseOrderId || !purchaseOrderItemId) {
      throw new Error(`第 ${index + 1} 行缺少采购单号或商品明细。`);
    }
    if (!Number.isInteger(acceptedQty) || acceptedQty <= 0) {
      throw new Error(`第 ${index + 1} 行验收数量必须为正整数。`);
    }
    if (selectedKeys.has(key)) {
      throw new Error(`采购明细 ${purchaseOrderItemId} 被重复选择。`);
    }

    const available = availableMap.get(key);
    if (!available || !available.arrivalId) {
      throw new Error(`采购明细 ${purchaseOrderItemId} 当前不可用于创建验收单。`);
    }
    if (acceptedQty > available.remainingQty) {
      throw new Error(`${available.sku} 的本次验收数量不能超过待验收数量 ${available.remainingQty}。`);
    }

    selectedKeys.add(key);
    selectedItems.push({ ...available, arrivalId: available.arrivalId, acceptedQty });
  });

  if (selectedItems.length === 0) {
    throw new Error('请选择至少一条待验收明细。');
  }

  const today = currentDateString();
  let targetArrivalId = '';

  const transaction = db.transaction(() => {
    const firstItem = selectedItems[0];
    const totalAcceptedQty = selectedItems.reduce((sum, item) => sum + item.acceptedQty, 0);
    targetArrivalId = nextDocumentId('receiving_notes', 'RCV', today);

    db.prepare(
      'INSERT INTO receiving_notes (id, purchase_order_id, supplier_id, expected_qty, arrived_qty, qualified_qty, defect_qty, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      targetArrivalId,
      firstItem.purchaseOrderId,
      firstItem.supplierId,
      totalAcceptedQty,
      totalAcceptedQty,
      totalAcceptedQty,
      0,
      ARRIVAL_STATUS_PENDING_INBOUND,
      today,
    );

    const updateReceivingItem = db.prepare(
      'UPDATE receiving_note_items SET qualified_qty = ?, defect_qty = ? WHERE id = ?',
    );
    const insertTargetItem = db.prepare(
      'INSERT INTO receiving_note_items (id, receiving_note_id, purchase_order_item_id, product_id, expected_qty, arrived_qty, qualified_qty, defect_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const affectedSourceArrivalIds = new Set<string>();

    selectedItems.forEach((item, index) => {
      const row = db.prepare<{ id: string; arrivedQty: number; qualifiedQty: number }>(`
        SELECT id, arrived_qty as arrivedQty, qualified_qty as qualifiedQty
        FROM receiving_note_items
        WHERE receiving_note_id = ? AND purchase_order_item_id = ?
      `).get(item.arrivalId, item.purchaseOrderItemId);

      if (!row) {
        throw new Error(`验收单 ${item.arrivalId} 中不存在商品明细 ${item.purchaseOrderItemId}。`);
      }

      const nextQualifiedQty = row.qualifiedQty + item.acceptedQty;
      if (nextQualifiedQty > row.arrivedQty) {
        throw new Error(`${item.sku} 的累计验收数量不能超过到货数量 ${row.arrivedQty}。`);
      }

      updateReceivingItem.run(nextQualifiedQty, 0, row.id);
      insertTargetItem.run(
        `${targetArrivalId}-ITEM-${index + 1}`,
        targetArrivalId,
        item.purchaseOrderItemId,
        item.productId,
        item.acceptedQty,
        item.acceptedQty,
        item.acceptedQty,
        0,
      );
      affectedSourceArrivalIds.add(item.arrivalId);
    });

    affectedSourceArrivalIds.forEach((arrivalId) => refreshSourceReceivingNoteAfterAcceptanceFlow(arrivalId));
    upsertInbound(targetArrivalId, totalAcceptedQty);

    appendAuditLog('create_manual_arrival_records', 'receiving_note', targetArrivalId, {
      arrivalIds: [targetArrivalId],
      sourceArrivalIds: Array.from(affectedSourceArrivalIds),
      sourcePurchaseOrderIds: Array.from(new Set(selectedItems.map((item) => item.purchaseOrderId))),
      itemCount: payloadItems.length,
    });
  });

  transaction();
  return { arrivalIds: [targetArrivalId] };
}

function upsertReceivingNoteItems(receivingNoteId: string, poId: string) {
  const poItems = db.prepare<{
    purchaseOrderItemId: string;
    productId: string;
    orderedQty: number;
  }>(`
    SELECT
      poi.id as purchaseOrderItemId,
      poi.product_id as productId,
      poi.ordered_qty as orderedQty
    FROM purchase_order_items poi
    WHERE poi.purchase_order_id = ?
    ORDER BY poi.id ASC
  `).all(poId);

  const insertItem = db.prepare(
    'INSERT OR IGNORE INTO receiving_note_items (id, receiving_note_id, purchase_order_item_id, product_id, expected_qty, arrived_qty, qualified_qty, defect_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  poItems.forEach((item, index) => {
    insertItem.run(
      `${receivingNoteId}-ITEM-${index + 1}`,
      receivingNoteId,
      item.purchaseOrderItemId,
      item.productId,
      item.orderedQty,
      0,
      0,
      0,
    );
  });
}

function loadReceivingNoteSourcePurchaseOrderIds(receivingNoteId: string) {
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

function recalculatePurchaseOrdersForReceivingNote(receivingNoteId: string) {
  const sourcePurchaseOrderIds = loadReceivingNoteSourcePurchaseOrderIds(receivingNoteId);
  sourcePurchaseOrderIds.forEach((purchaseOrderId) => {
    recalculatePurchaseOrderStatus(purchaseOrderId);
  });
  return sourcePurchaseOrderIds;
}

function ensureArrivalEditable(arrival: ArrivalRow | undefined) {
  if (!arrival) {
    return;
  }

  if (arrival.status === ARRIVAL_STATUS_PENDING_INBOUND || arrival.status === ARRIVAL_STATUS_INBOUND_DONE) {
    throw new Error('该采购单已进入验收入库流程，请前往验收入库界面继续处理。');
  }
}

export function getProcurementArrivalWorkspace(purchaseOrderId: string): ProcurementArrivalWorkspaceRecord | null {
  const purchaseOrder = loadPurchaseOrderForArrival(purchaseOrderId);
  if (!purchaseOrder) {
    return null;
  }

  const arrival = loadArrivalByPurchaseOrder(purchaseOrderId);
  const items = loadPurchaseOrderItemsForArrival(purchaseOrderId).map((item) => ({
    itemId: item.itemId,
    sku: item.sku,
    productName: item.productName,
    orderedQty: item.orderedQty,
    arrivedQty: item.arrivedQty,
    remainingQty: Math.max(item.orderedQty - item.arrivedQty, 0),
  }));

  const totalOrderedQty = items.reduce((sum, item) => sum + item.orderedQty, 0);
  const totalArrivedQty = items.reduce((sum, item) => sum + item.arrivedQty, 0);
  const totalRemainingQty = items.reduce((sum, item) => sum + item.remainingQty, 0);
  const normalizedProcurementStatus = normalizeProcurementStatus(purchaseOrder.status);
  const editable =
    normalizedProcurementStatus !== '已取消' &&
    normalizedProcurementStatus !== '已完成' &&
    (!arrival || (arrival.status !== ARRIVAL_STATUS_PENDING_INBOUND && arrival.status !== ARRIVAL_STATUS_INBOUND_DONE));

  return {
    purchaseOrderId: purchaseOrder.id,
    arrivalId: arrival?.id,
    supplier: purchaseOrder.supplier,
    expectedDate: purchaseOrder.expectedDate,
    procurementStatus: normalizedProcurementStatus,
    arrivalStatus: arrival?.status,
    arrivedAt: arrival?.arrivedAt,
    editable,
    items,
    totalOrderedQty,
    totalArrivedQty,
    totalRemainingQty,
  };
}

export function registerProcurementArrival(purchaseOrderId: string, payload: RegisterProcurementArrivalPayload) {
  const purchaseOrder = loadPurchaseOrderForArrival(purchaseOrderId);
  if (!purchaseOrder) {
    throw new Error('Purchase order not found');
  }
  if (purchaseOrder.status === '已取消') {
    throw new Error('Cancelled purchase order cannot be registered as arrived');
  }
  if (purchaseOrder.status === '已完成') {
    throw new Error('Completed purchase order does not need another arrival registration');
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('Arrival items are required');
  }

  const arrival = loadArrivalByPurchaseOrder(purchaseOrderId);
  ensureArrivalEditable(arrival);

  const poItems = loadPurchaseOrderItemsForArrival(purchaseOrderId);
  const poItemMap = new Map(poItems.map((item) => [item.itemId, item]));
  const payloadMap = new Map<string, number>();

  payload.items.forEach((item, index) => {
    if (!item.itemId?.trim()) {
      throw new Error(`items[${index}].itemId is required`);
    }
    if (!Number.isInteger(item.arrivedQty) || item.arrivedQty < 0) {
      throw new Error(`items[${index}].arrivedQty must be a non-negative integer`);
    }
    if (!poItemMap.has(item.itemId.trim())) {
      throw new Error(`Arrival item ${item.itemId} does not belong to this purchase order`);
    }
    payloadMap.set(item.itemId.trim(), item.arrivedQty);
  });

  let hasArrivalQty = false;
  poItems.forEach((item) => {
    const deltaQty = payloadMap.get(item.itemId) ?? 0;
    const remainingQty = Math.max(item.orderedQty - item.arrivedQty, 0);
    if (deltaQty > remainingQty) {
      throw new Error(`${item.sku} 的到货数量不能超过未到货数量 ${remainingQty}`);
    }
    if (deltaQty > 0) {
      hasArrivalQty = true;
    }
  });

  if (!hasArrivalQty) {
    throw new Error('璇疯嚦灏戠櫥璁颁竴椤瑰晢鍝佺殑鍒拌揣鏁伴噺');
  }

  const today = currentDateString();

  const transaction = db.transaction(() => {
    const receivingNoteId = arrival?.id || nextDocumentId('receiving_notes', 'RCV', today);

    if (!arrival) {
      db.prepare(
        'INSERT INTO receiving_notes (id, purchase_order_id, supplier_id, expected_qty, arrived_qty, qualified_qty, defect_qty, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        receivingNoteId,
        purchaseOrderId,
        purchaseOrder.supplierId,
        0,
        0,
        0,
        0,
        ARRIVAL_STATUS_PENDING,
        today,
      );
    }

    upsertReceivingNoteItems(receivingNoteId, purchaseOrderId);

    const receivingItems = db.prepare<{
      id: string;
      purchaseOrderItemId: string;
      expectedQty: number;
      arrivedQty: number;
    }>(`
      SELECT
        id,
        purchase_order_item_id as purchaseOrderItemId,
        expected_qty as expectedQty,
        arrived_qty as arrivedQty
      FROM receiving_note_items
      WHERE receiving_note_id = ?
      ORDER BY id ASC
    `).all(receivingNoteId);

    const updateReceivingItem = db.prepare(
      'UPDATE receiving_note_items SET arrived_qty = ?, qualified_qty = 0, defect_qty = 0 WHERE id = ?',
    );
    const updatePurchaseItem = db.prepare('UPDATE purchase_order_items SET arrived_qty = ? WHERE id = ?');

    let totalExpectedQty = 0;
    let totalArrivedQty = 0;

    receivingItems.forEach((item) => {
      const deltaQty = payloadMap.get(item.purchaseOrderItemId) ?? 0;
      const nextArrivedQty = item.arrivedQty + deltaQty;
    if (nextArrivedQty > item.expectedQty) {
      throw new Error(`采购明细 ${item.purchaseOrderItemId} 的累计到货数量不能超过应到数量 ${item.expectedQty}。`);
    }
      totalExpectedQty += item.expectedQty;
      totalArrivedQty += nextArrivedQty;
      updateReceivingItem.run(nextArrivedQty, item.id);
      updatePurchaseItem.run(nextArrivedQty, item.purchaseOrderItemId);
    });

    db.prepare(
      'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = 0, defect_qty = 0, status = ?, arrived_at = ? WHERE id = ?',
    ).run(totalExpectedQty, totalArrivedQty, ARRIVAL_STATUS_PENDING, today, receivingNoteId);
    db.prepare('DELETE FROM inbound_orders WHERE receiving_note_id = ? AND status <> ?').run(receivingNoteId, ARRIVAL_STATUS_INBOUND_DONE);

    recalculatePurchaseOrderStatus(purchaseOrderId);

    appendAuditLog('register_procurement_arrival', 'purchase_order', purchaseOrderId, {
      receivingNoteId,
      totalExpectedQty,
      totalArrivedQty,
      arrivalItems: payload.items.filter((item) => item.arrivedQty > 0),
    });
  });

  transaction();
  return getProcurementArrivalWorkspace(purchaseOrderId) as ProcurementArrivalWorkspaceRecord;
}

export function createManualArrivalRecords(payloadItems: CreateManualArrivalItemPayload[]): CreateManualArrivalResult {
  if (!Array.isArray(payloadItems) || payloadItems.length === 0) {
    throw new Error('请选择至少一条商品明细。');
  }
  return createAcceptanceFromPendingArrivals(payloadItems);
}

export function getArrivalDetail(arrivalId: string): ArrivalDetailRecord | null {
  const arrival = loadArrival(arrivalId);
  if (!arrival) {
    return null;
  }

  const items = loadArrivalItems(arrivalId);
  const sourcePurchaseOrderIds = loadReceivingNoteSourcePurchaseOrderIds(arrivalId);

  return {
    id: arrival.id,
    poId: arrival.poId,
    supplier: arrival.supplier,
    expectedQty: arrival.expectedQty,
    arrivedQty: arrival.arrivedQty,
    qualifiedQty: arrival.qualifiedQty,
    defectQty: arrival.defectQty,
    status: arrival.status,
    arrivedAt: arrival.arrivedAt,
    sourcePurchaseOrderIds,
    items: items.map((item) => ({
      id: item.id,
      sku: item.sku,
      productName: item.productName,
      expectedQty: item.expectedQty,
      arrivedQty: item.arrivedQty,
      qualifiedQty: item.qualifiedQty,
      defectQty: item.defectQty,
    })),
  };
}

function upsertInbound(receivingNoteId: string, inboundQty: number) {
  const existing = db
    .prepare<{ id: string; status: string }>('SELECT id, status FROM inbound_orders WHERE receiving_note_id = ?')
    .get(receivingNoteId);

  if (existing) {
    if (existing.status !== '已入库') {
      db.prepare('UPDATE inbound_orders SET inbound_qty = ?, status = ? WHERE id = ?').run(inboundQty, '待入库', existing.id);
    }
    return existing.id;
  }

  const inboundId = nextDocumentId('inbound_orders', 'INB');
  db.prepare(
    'INSERT INTO inbound_orders (id, receiving_note_id, warehouse_id, inbound_qty, status, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(inboundId, receivingNoteId, DEFAULT_WAREHOUSE_ID, inboundQty, '待入库', null);
  return inboundId;
}

function refreshPurchaseItemArrivedQuantity(purchaseOrderItemId: string) {
  const nextArrivedQty =
    db.prepare<{ arrivedQty: number }>(`
      SELECT COALESCE(MAX(CASE WHEN qualified_qty > 0 THEN qualified_qty ELSE arrived_qty END), 0) as arrivedQty
      FROM receiving_note_items
      WHERE purchase_order_item_id = ?
    `).get(purchaseOrderItemId)?.arrivedQty ?? 0;

  db.prepare('UPDATE purchase_order_items SET arrived_qty = ? WHERE id = ?').run(nextArrivedQty, purchaseOrderItemId);
}

function refreshReceivingNoteAfterForce(receivingNoteId: string) {
  const totals =
    db.prepare<{ expectedQty: number; arrivedQty: number; qualifiedQty: number; defectQty: number }>(`
      SELECT
        COALESCE(SUM(expected_qty), 0) as expectedQty,
        COALESCE(SUM(arrived_qty), 0) as arrivedQty,
        COALESCE(SUM(qualified_qty), 0) as qualifiedQty,
        COALESCE(SUM(defect_qty), 0) as defectQty
      FROM receiving_note_items
      WHERE receiving_note_id = ?
    `).get(receivingNoteId) ?? { expectedQty: 0, arrivedQty: 0, qualifiedQty: 0, defectQty: 0 };
  const inbound = db
    .prepare<{ id: string; status: string }>('SELECT id, status FROM inbound_orders WHERE receiving_note_id = ?')
    .get(receivingNoteId);

  if (inbound?.status === ARRIVAL_STATUS_INBOUND_DONE) {
    db.prepare(
      'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = ?, status = ? WHERE id = ?',
    ).run(
      totals.expectedQty,
      totals.arrivedQty,
      totals.qualifiedQty,
      totals.defectQty,
      ARRIVAL_STATUS_INBOUND_DONE,
      receivingNoteId,
    );
    return;
  }

  if (totals.arrivedQty > 0 && totals.qualifiedQty >= totals.arrivedQty) {
    db.prepare(
      'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = ?, status = ? WHERE id = ?',
    ).run(
      totals.expectedQty,
      totals.arrivedQty,
      totals.qualifiedQty,
      totals.defectQty,
      ARRIVAL_STATUS_PENDING_INBOUND,
      receivingNoteId,
    );
    upsertInbound(receivingNoteId, totals.qualifiedQty);
    return;
  }

  db.prepare(
    'UPDATE receiving_notes SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = ?, status = ? WHERE id = ?',
  ).run(totals.expectedQty, totals.arrivedQty, totals.qualifiedQty, totals.defectQty, ARRIVAL_STATUS_PENDING, receivingNoteId);
  db.prepare('DELETE FROM inbound_orders WHERE receiving_note_id = ? AND status <> ?').run(receivingNoteId, ARRIVAL_STATUS_INBOUND_DONE);
}

export function forceUpdateArrivalLines(arrivalId: string, payload: ForceUpdateArrivalLinesPayload) {
  const arrival = loadArrival(arrivalId);
  if (!arrival) {
    throw new Error('Arrival record not found');
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('items are required');
  }

  const currentItems = loadArrivalItems(arrivalId);
  const itemMap = new Map(currentItems.map((item) => [item.id, item]));
  const seenItemIds = new Set<string>();
  const normalizedItems = payload.items.map((item, index) => {
    const itemId = String(item.itemId || '').trim();
    const expectedQty = Number(item.expectedQty);
    const arrivedQty = Number(item.arrivedQty);
    const qualifiedQty = Number(item.qualifiedQty);
    const defectQty = Number(item.defectQty);

    if (!itemId) {
      throw new Error(`items[${index}].itemId is required`);
    }
    if (seenItemIds.has(itemId)) {
      throw new Error(`Duplicate arrival item ${itemId}`);
    }
    const currentItem = itemMap.get(itemId);
    if (!currentItem) {
      throw new Error(`Arrival item ${itemId} does not belong to ${arrivalId}`);
    }
    if (!Number.isInteger(expectedQty) || expectedQty < 0) {
      throw new Error(`items[${index}].expectedQty must be a non-negative integer`);
    }
    if (!Number.isInteger(arrivedQty) || arrivedQty < 0 || arrivedQty > expectedQty) {
      throw new Error(`items[${index}].arrivedQty must be between 0 and expectedQty`);
    }
    if (!Number.isInteger(qualifiedQty) || qualifiedQty < 0 || qualifiedQty > arrivedQty) {
      throw new Error(`items[${index}].qualifiedQty must be between 0 and arrivedQty`);
    }
    if (!Number.isInteger(defectQty) || defectQty < 0 || qualifiedQty + defectQty > arrivedQty) {
      throw new Error(`items[${index}].defectQty is invalid`);
    }

    const inboundQty =
      db.prepare<{ inboundQty: number }>('SELECT inbound_qty as inboundQty FROM receiving_note_items WHERE id = ?').get(itemId)
        ?.inboundQty ?? 0;
    if (qualifiedQty < inboundQty) {
      throw new Error(`验收明细 ${itemId} 已有 ${inboundQty} 件入库数量，合格数量不能低于该值。`);
    }

    seenItemIds.add(itemId);
    return {
      itemId,
      expectedQty,
      arrivedQty,
      qualifiedQty,
      defectQty,
      purchaseOrderItemId: currentItem.purchaseOrderItemId,
      previousExpectedQty: currentItem.expectedQty,
      previousArrivedQty: currentItem.arrivedQty,
      previousQualifiedQty: currentItem.qualifiedQty,
      previousDefectQty: currentItem.defectQty,
    };
  });

  const reason = String(payload.reason || '').trim() || '管理员强制修正验收明细';
  const updateItem = db.prepare(
    'UPDATE receiving_note_items SET expected_qty = ?, arrived_qty = ?, qualified_qty = ?, defect_qty = ? WHERE id = ?',
  );

  const transaction = db.transaction(() => {
    normalizedItems.forEach((item) => {
      updateItem.run(item.expectedQty, item.arrivedQty, item.qualifiedQty, item.defectQty, item.itemId);
      refreshPurchaseItemArrivedQuantity(item.purchaseOrderItemId);
    });

    refreshReceivingNoteAfterForce(arrivalId);
    recalculatePurchaseOrdersForReceivingNote(arrivalId);

    appendAuditLog('force_update_arrival_lines', 'receiving_note', arrivalId, {
      reason,
      itemCount: normalizedItems.length,
      items: normalizedItems,
    });
  });

  transaction();
  return getArrivalDetail(arrivalId) as ArrivalDetailRecord;
}

export function advanceArrival(arrivalId: string) {
  const arrival = loadArrival(arrivalId);
  if (!arrival) {
    throw new Error('Arrival record not found');
  }

  const items = loadArrivalItems(arrivalId);
  const today = currentDateString();

  const transaction = db.transaction(() => {
    if (arrival.status === '已验收待入库' || arrival.status === '已入库') {
      return;
    }

    if (arrival.status === '部分到货') {
      db.prepare(
        'UPDATE receiving_notes SET arrived_qty = expected_qty, qualified_qty = expected_qty, defect_qty = 0, status = ?, arrived_at = ? WHERE id = ?',
      ).run('已验收待入库', today, arrivalId);

      items.forEach((item) => {
        db.prepare(
          'UPDATE receiving_note_items SET arrived_qty = expected_qty, qualified_qty = expected_qty, defect_qty = 0 WHERE id = ?',
        ).run(item.id);
        db.prepare('UPDATE purchase_order_items SET arrived_qty = ordered_qty WHERE id = ?').run(item.purchaseOrderItemId);
      });
    } else {
      const qualifiedQty = Math.max(arrival.arrivedQty - arrival.defectQty, 0);
      db.prepare('UPDATE receiving_notes SET qualified_qty = ?, status = ? WHERE id = ?').run(
        qualifiedQty,
        '已验收待入库',
        arrivalId,
      );

      items.forEach((item) => {
        const nextQualified = Math.max(item.arrivedQty - item.defectQty, 0);
        db.prepare('UPDATE receiving_note_items SET qualified_qty = ? WHERE id = ?').run(nextQualified, item.id);
        db.prepare('UPDATE purchase_order_items SET arrived_qty = ? WHERE id = ?').run(nextQualified, item.purchaseOrderItemId);
      });
    }

    const inboundQty = db
      .prepare<{ total: number }>('SELECT COALESCE(SUM(qualified_qty), 0) as total FROM receiving_note_items WHERE receiving_note_id = ?')
      .get(arrivalId)?.total ?? 0;

    const inboundId = upsertInbound(arrivalId, inboundQty);
    const sourcePurchaseOrderIds = recalculatePurchaseOrdersForReceivingNote(arrivalId);

    appendAuditLog('advance_arrival', 'receiving_note', arrivalId, {
      inboundId,
      previousStatus: arrival.status,
      nextStatus: '已验收待入库',
      sourcePurchaseOrderIds,
    });
  });

  transaction();
  return loadArrival(arrivalId) as ArrivalRecord;
}

