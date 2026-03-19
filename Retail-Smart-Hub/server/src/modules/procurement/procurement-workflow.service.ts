import { db } from '../../database/db';

const PO_STATUS_DRAFT = '\u5F85\u5BA1\u6838';
const PO_STATUS_ACTIVE = '\u91C7\u8D2D\u4E2D';
const PO_STATUS_PARTIAL = '\u90E8\u5206\u5230\u8D27';
const PO_STATUS_DONE = '\u5DF2\u5B8C\u6210';
const PO_STATUS_CANCELLED = '\u5DF2\u53D6\u6D88';
const INBOUND_STATUS_DONE = '\u5DF2\u5165\u5E93';

export function recalculatePurchaseOrderStatus(purchaseOrderId: string) {
  const currentStatus =
    db.prepare<{ status: string }>('SELECT status FROM purchase_orders WHERE id = ?').get(purchaseOrderId)?.status ?? PO_STATUS_ACTIVE;

  if (currentStatus === PO_STATUS_CANCELLED) {
    return currentStatus;
  }

  const items = db.prepare<{ orderedQty: number; arrivedQty: number }>(`
    SELECT ordered_qty as orderedQty, arrived_qty as arrivedQty
    FROM purchase_order_items
    WHERE purchase_order_id = ?
  `).all(purchaseOrderId);

  const hasUnreceived = items.some((item) => item.arrivedQty < item.orderedQty);
  const hasArrived = items.some((item) => item.arrivedQty > 0);
  const hasPendingInbound = (db.prepare<{ count: number }>(`
    SELECT COUNT(*) as count
    FROM inbound_orders io
    JOIN receiving_notes rn ON rn.id = io.receiving_note_id
    WHERE rn.purchase_order_id = ? AND io.status <> ?
  `).get(purchaseOrderId, INBOUND_STATUS_DONE)?.count ?? 0) > 0;

  let nextStatus = PO_STATUS_ACTIVE;
  if (!hasArrived) {
    nextStatus = currentStatus === PO_STATUS_DRAFT ? PO_STATUS_DRAFT : PO_STATUS_ACTIVE;
  } else if (!hasUnreceived && !hasPendingInbound) {
    nextStatus = PO_STATUS_DONE;
  } else {
    nextStatus = PO_STATUS_PARTIAL;
  }

  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(nextStatus, purchaseOrderId);
  return nextStatus;
}