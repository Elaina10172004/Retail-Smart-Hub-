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

export function listArrivals() {
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

export function getArrivalDetail(arrivalId: string): ArrivalDetailRecord | null {
  const arrival = loadArrival(arrivalId);
  if (!arrival) {
    return null;
  }

  const items = loadArrivalItems(arrivalId);

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
  const existing = db.prepare<{ id: string; status: string }>(
    'SELECT id, status FROM inbound_orders WHERE receiving_note_id = ?'
  ).get(receivingNoteId);

  if (existing) {
    if (existing.status !== '已入库') {
      db.prepare('UPDATE inbound_orders SET inbound_qty = ?, status = ? WHERE id = ?').run(inboundQty, '待入库', existing.id);
    }
    return existing.id;
  }

  const inboundId = nextDocumentId('inbound_orders', 'INB');
  db.prepare(
    'INSERT INTO inbound_orders (id, receiving_note_id, warehouse_id, inbound_qty, status, completed_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(inboundId, receivingNoteId, DEFAULT_WAREHOUSE_ID, inboundQty, '待入库', null);
  return inboundId;
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
        'UPDATE receiving_notes SET arrived_qty = expected_qty, qualified_qty = expected_qty, defect_qty = 0, status = ?, arrived_at = ? WHERE id = ?'
      ).run('已验收待入库', today, arrivalId);

      items.forEach((item) => {
        db.prepare(
          'UPDATE receiving_note_items SET arrived_qty = expected_qty, qualified_qty = expected_qty, defect_qty = 0 WHERE id = ?'
        ).run(item.id);
        db.prepare('UPDATE purchase_order_items SET arrived_qty = ordered_qty WHERE id = ?').run(item.purchaseOrderItemId);
      });
    } else {
      const qualifiedQty = Math.max(arrival.arrivedQty - arrival.defectQty, 0);
      db.prepare('UPDATE receiving_notes SET qualified_qty = ?, status = ? WHERE id = ?').run(qualifiedQty, '已验收待入库', arrivalId);

      items.forEach((item) => {
        const nextQualified = Math.max(item.arrivedQty - item.defectQty, 0);
        db.prepare('UPDATE receiving_note_items SET qualified_qty = ? WHERE id = ?').run(nextQualified, item.id);
        db.prepare('UPDATE purchase_order_items SET arrived_qty = ? WHERE id = ?').run(nextQualified, item.purchaseOrderItemId);
      });
    }

    const inboundQty = db.prepare<{ total: number }>(
      'SELECT COALESCE(SUM(qualified_qty), 0) as total FROM receiving_note_items WHERE receiving_note_id = ?'
    ).get(arrivalId)?.total ?? 0;

    const inboundId = upsertInbound(arrivalId, inboundQty);
    recalculatePurchaseOrderStatus(arrival.poId);

    appendAuditLog('advance_arrival', 'receiving_note', arrivalId, {
      inboundId,
      previousStatus: arrival.status,
      nextStatus: '已验收待入库',
    });
  });

  transaction();
  return loadArrival(arrivalId) as ArrivalRecord;
}
