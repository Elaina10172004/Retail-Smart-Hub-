import { appendAuditLog, db, nextDocumentId, syncFinanceDocuments } from '../../database/db';
import { addDays, currentDateString } from '../../shared/format';

export type ReceivableStatus = '未收款' | '部分收款' | '已收款' | '逾期';
export type PayableStatus = '未付款' | '部分付款' | '已付款' | '逾期';

export interface FinanceOverview {
  totalReceivable: number;
  overdueReceivable: number;
  totalPayable: number;
  dueThisWeekPayable: number;
  monthlyReceived: number;
  monthlyPaid: number;
  pendingReceivableCount: number;
  pendingPayableCount: number;
}

export interface ReceiptRecord {
  id: string;
  receivableId: string;
  amount: number;
  receivedAt: string;
  method: string;
  remark?: string;
}

export interface PaymentRecord {
  id: string;
  payableId: string;
  amount: number;
  paidAt: string;
  method: string;
  remark?: string;
}

export interface ReceivableRecord {
  id: string;
  orderId: string;
  customer: string;
  amountDue: number;
  amountPaid: number;
  remainingAmount: number;
  dueDate: string;
  lastReceivedAt?: string;
  status: ReceivableStatus;
  daysOverdue: number;
}

export interface ReceivableMutationResult extends ReceivableRecord {
  latestReceiptId: string;
}

export interface ReceivableDetailRecord extends ReceivableRecord {
  customerName: string;
  orderChannel: string;
  remark?: string;
  records: ReceiptRecord[];
}

export interface PayableRecord {
  id: string;
  purchaseOrderId: string;
  supplier: string;
  amountDue: number;
  amountPaid: number;
  remainingAmount: number;
  dueDate: string;
  lastPaidAt?: string;
  status: PayableStatus;
  daysOverdue: number;
}

export interface PayableMutationResult extends PayableRecord {
  latestPaymentId: string;
}

export interface PayableDetailRecord extends PayableRecord {
  remark?: string;
  records: PaymentRecord[];
}

interface ReceivableRow {
  id: string;
  orderId: string;
  customerName: string;
  orderChannel: string;
  amountDue: number;
  amountPaid: number;
  dueDate: string;
  lastReceivedAt: string | null;
  remark: string | null;
}

interface PayableRow {
  id: string;
  purchaseOrderId: string;
  supplierName: string;
  amountDue: number;
  amountPaid: number;
  dueDate: string;
  lastPaidAt: string | null;
  remark: string | null;
}

function diffDays(targetDate: string, baseDate = currentDateString()) {
  const target = new Date(`${targetDate}T00:00:00`).getTime();
  const base = new Date(`${baseDate}T00:00:00`).getTime();
  return Math.max(Math.floor((base - target) / (1000 * 60 * 60 * 24)), 0);
}

function computeReceivableStatus(amountDue: number, amountPaid: number, dueDate: string): ReceivableStatus {
  if (amountPaid >= amountDue) {
    return '已收款';
  }

  if (dueDate < currentDateString()) {
    return '逾期';
  }

  if (amountPaid > 0) {
    return '部分收款';
  }

  return '未收款';
}

function computePayableStatus(amountDue: number, amountPaid: number, dueDate: string): PayableStatus {
  if (amountPaid >= amountDue) {
    return '已付款';
  }

  if (dueDate < currentDateString()) {
    return '逾期';
  }

  if (amountPaid > 0) {
    return '部分付款';
  }

  return '未付款';
}

function loadReceivableRows() {
  return db.prepare<ReceivableRow>(`
    SELECT
      r.id,
      so.id as orderId,
      so.customer_name as customerName,
      so.order_channel as orderChannel,
      r.amount_due as amountDue,
      r.amount_paid as amountPaid,
      r.due_date as dueDate,
      r.last_received_at as lastReceivedAt,
      r.remark
    FROM receivables r
    JOIN sales_orders so ON so.id = r.sales_order_id
    ORDER BY r.due_date ASC, r.id DESC
  `).all();
}

function loadPayableRows() {
  return db.prepare<PayableRow>(`
    SELECT
      p.id,
      po.id as purchaseOrderId,
      s.name as supplierName,
      p.amount_due as amountDue,
      p.amount_paid as amountPaid,
      p.due_date as dueDate,
      p.last_paid_at as lastPaidAt,
      p.remark
    FROM payables p
    JOIN purchase_orders po ON po.id = p.purchase_order_id
    JOIN suppliers s ON s.id = po.supplier_id
    ORDER BY p.due_date ASC, p.id DESC
  `).all();
}

function toReceivableRecord(row: ReceivableRow): ReceivableRecord {
  const status = computeReceivableStatus(row.amountDue, row.amountPaid, row.dueDate);
  const remainingAmount = Math.max(row.amountDue - row.amountPaid, 0);

  return {
    id: row.id,
    orderId: row.orderId,
    customer: `${row.customerName} / ${row.orderChannel}`,
    amountDue: row.amountDue,
    amountPaid: row.amountPaid,
    remainingAmount,
    dueDate: row.dueDate,
    lastReceivedAt: row.lastReceivedAt ?? undefined,
    status,
    daysOverdue: status === '逾期' ? diffDays(row.dueDate) : 0,
  };
}

function toPayableRecord(row: PayableRow): PayableRecord {
  const status = computePayableStatus(row.amountDue, row.amountPaid, row.dueDate);
  const remainingAmount = Math.max(row.amountDue - row.amountPaid, 0);

  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    supplier: row.supplierName,
    amountDue: row.amountDue,
    amountPaid: row.amountPaid,
    remainingAmount,
    dueDate: row.dueDate,
    lastPaidAt: row.lastPaidAt ?? undefined,
    status,
    daysOverdue: status === '逾期' ? diffDays(row.dueDate) : 0,
  };
}

function loadReceiptRows(receivableId?: string) {
  if (receivableId) {
    return db.prepare<ReceiptRecord>(`
      SELECT
        id,
        receivable_id as receivableId,
        amount,
        received_at as receivedAt,
        method,
        remark
      FROM receipt_records
      WHERE receivable_id = ?
      ORDER BY received_at DESC, id DESC
    `).all(receivableId);
  }

  return db.prepare<ReceiptRecord>(`
    SELECT
      id,
      receivable_id as receivableId,
      amount,
      received_at as receivedAt,
      method,
      remark
    FROM receipt_records
    ORDER BY received_at DESC, id DESC
  `).all();
}

function loadPaymentRows(payableId?: string) {
  if (payableId) {
    return db.prepare<PaymentRecord>(`
      SELECT
        id,
        payable_id as payableId,
        amount,
        paid_at as paidAt,
        method,
        remark
      FROM payment_records
      WHERE payable_id = ?
      ORDER BY paid_at DESC, id DESC
    `).all(payableId);
  }

  return db.prepare<PaymentRecord>(`
    SELECT
      id,
      payable_id as payableId,
      amount,
      paid_at as paidAt,
      method,
      remark
    FROM payment_records
    ORDER BY paid_at DESC, id DESC
  `).all();
}

export function getFinanceOverview(): FinanceOverview {
  const receivables = listReceivables();
  const payables = listPayables();
  const currentMonth = currentDateString().slice(0, 7);
  const weekEnd = addDays(currentDateString(), 7);

  const monthlyReceived =
    db.prepare<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM receipt_records WHERE substr(received_at, 1, 7) = ?`
    ).get(currentMonth)?.total ?? 0;

  const monthlyPaid =
    db.prepare<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM payment_records WHERE substr(paid_at, 1, 7) = ?`
    ).get(currentMonth)?.total ?? 0;

  return {
    totalReceivable: receivables.reduce((sum, item) => sum + item.remainingAmount, 0),
    overdueReceivable: receivables
      .filter((item) => item.status === '逾期')
      .reduce((sum, item) => sum + item.remainingAmount, 0),
    totalPayable: payables.reduce((sum, item) => sum + item.remainingAmount, 0),
    dueThisWeekPayable: payables
      .filter((item) => item.status !== '已付款' && item.dueDate >= currentDateString() && item.dueDate <= weekEnd)
      .reduce((sum, item) => sum + item.remainingAmount, 0),
    monthlyReceived,
    monthlyPaid,
    pendingReceivableCount: receivables.filter((item) => item.status !== '已收款').length,
    pendingPayableCount: payables.filter((item) => item.status !== '已付款').length,
  };
}

export function listReceivables() {
  return loadReceivableRows().map(toReceivableRecord);
}

export function getReceivableDetail(id: string): ReceivableDetailRecord | null {
  const row = loadReceivableRows().find((item) => item.id === id);
  if (!row) {
    return null;
  }

  const base = toReceivableRecord(row);
  return {
    ...base,
    customerName: row.customerName,
    orderChannel: row.orderChannel,
    remark: row.remark ?? undefined,
    records: loadReceiptRows(id).map((record) => ({
      ...record,
      remark: record.remark || undefined,
    })),
  };
}

export function listReceiptRecords(receivableId?: string) {
  return loadReceiptRows(receivableId).map((record) => ({
    ...record,
    remark: record.remark || undefined,
  }));
}

export function listPayables() {
  return loadPayableRows().map(toPayableRecord);
}

export function getPayableDetail(id: string): PayableDetailRecord | null {
  const row = loadPayableRows().find((item) => item.id === id);
  if (!row) {
    return null;
  }

  const base = toPayableRecord(row);
  return {
    ...base,
    remark: row.remark ?? undefined,
    records: loadPaymentRows(id).map((record) => ({
      ...record,
      remark: record.remark || undefined,
    })),
  };
}

export function listPaymentRecords(payableId?: string) {
  return loadPaymentRows(payableId).map((record) => ({
    ...record,
    remark: record.remark || undefined,
  }));
}

export function receiveReceivable(id: string, amount: number, method = '银行转账', remark?: string): ReceivableMutationResult {
  const receivable = loadReceivableRows().find((item) => item.id === id);
  if (!receivable) {
    throw new Error('Receivable not found');
  }

  const remainingAmount = Math.max(receivable.amountDue - receivable.amountPaid, 0);
  if (remainingAmount <= 0) {
    throw new Error('Receivable already settled');
  }

  if (amount <= 0 || amount > remainingAmount) {
    throw new Error('Invalid receipt amount');
  }

  const receivedAt = currentDateString();
  const receiptId = nextDocumentId('receipt_records', 'REC', receivedAt);

  const transaction = db.transaction(() => {
    db.prepare('UPDATE receivables SET amount_paid = amount_paid + ?, last_received_at = ? WHERE id = ?').run(
      amount,
      receivedAt,
      id
    );

    db.prepare(
      'INSERT INTO receipt_records (id, receivable_id, amount, received_at, method, remark) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(receiptId, id, amount, receivedAt, method, remark?.trim() || null);

    appendAuditLog('receive_receivable', 'receivable', id, {
      amount,
      method,
      receivedAt,
    });
  });

  transaction();

  const record = listReceivables().find((item) => item.id === id) as ReceivableRecord;
  return {
    ...record,
    latestReceiptId: receiptId,
  };
}

export function payPayable(id: string, amount: number, method = '对公转账', remark?: string): PayableMutationResult {
  const payable = loadPayableRows().find((item) => item.id === id);
  if (!payable) {
    throw new Error('Payable not found');
  }

  const remainingAmount = Math.max(payable.amountDue - payable.amountPaid, 0);
  if (remainingAmount <= 0) {
    throw new Error('Payable already settled');
  }

  if (amount <= 0 || amount > remainingAmount) {
    throw new Error('Invalid payment amount');
  }

  const paidAt = currentDateString();
  const paymentId = nextDocumentId('payment_records', 'PAY', paidAt);

  const transaction = db.transaction(() => {
    db.prepare('UPDATE payables SET amount_paid = amount_paid + ?, last_paid_at = ? WHERE id = ?').run(
      amount,
      paidAt,
      id
    );

    db.prepare(
      'INSERT INTO payment_records (id, payable_id, amount, paid_at, method, remark) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(paymentId, id, amount, paidAt, method, remark?.trim() || null);

    appendAuditLog('pay_payable', 'payable', id, {
      amount,
      method,
      paidAt,
    });
  });

  transaction();

  const record = listPayables().find((item) => item.id === id) as PayableRecord;
  return {
    ...record,
    latestPaymentId: paymentId,
  };
}

export function undoReceiptRecord(receivableId: string, receiptId: string) {
  const record = db.prepare<{
    id: string;
    receivableId: string;
    amount: number;
    receivedAt: string;
    method: string;
    remark: string | null;
  }>(`
    SELECT
      id,
      receivable_id as receivableId,
      amount,
      received_at as receivedAt,
      method,
      remark
    FROM receipt_records
    WHERE id = ? AND receivable_id = ?
  `).get(receiptId, receivableId);

  if (!record) {
    throw new Error('指定的收款记录不存在');
  }

  const latestRecord = db.prepare<{ id: string }>(`
    SELECT id
    FROM receipt_records
    WHERE receivable_id = ?
    ORDER BY received_at DESC, id DESC
    LIMIT 1
  `).get(receivableId);

  if (!latestRecord || latestRecord.id !== receiptId) {
    throw new Error('只能撤回该应收单最近一笔收款记录');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM receipt_records WHERE id = ?').run(receiptId);
    db.prepare('UPDATE receivables SET amount_paid = MAX(amount_paid - ?, 0) WHERE id = ?').run(record.amount, receivableId);

    const nextLastReceivedAt =
      db.prepare<{ receivedAt: string | null }>(`
        SELECT received_at as receivedAt
        FROM receipt_records
        WHERE receivable_id = ?
        ORDER BY received_at DESC, id DESC
        LIMIT 1
      `).get(receivableId)?.receivedAt ?? null;

    db.prepare('UPDATE receivables SET last_received_at = ? WHERE id = ?').run(nextLastReceivedAt, receivableId);

    appendAuditLog('undo_receive_receivable', 'receivable', receivableId, {
      receiptId,
      amount: record.amount,
      method: record.method,
    });
  });

  transaction();

  return getReceivableDetail(receivableId);
}

export function undoPaymentRecord(payableId: string, paymentId: string) {
  const record = db.prepare<{
    id: string;
    payableId: string;
    amount: number;
    paidAt: string;
    method: string;
    remark: string | null;
  }>(`
    SELECT
      id,
      payable_id as payableId,
      amount,
      paid_at as paidAt,
      method,
      remark
    FROM payment_records
    WHERE id = ? AND payable_id = ?
  `).get(paymentId, payableId);

  if (!record) {
    throw new Error('指定的付款记录不存在');
  }

  const latestRecord = db.prepare<{ id: string }>(`
    SELECT id
    FROM payment_records
    WHERE payable_id = ?
    ORDER BY paid_at DESC, id DESC
    LIMIT 1
  `).get(payableId);

  if (!latestRecord || latestRecord.id !== paymentId) {
    throw new Error('只能撤回该应付单最近一笔付款记录');
  }

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM payment_records WHERE id = ?').run(paymentId);
    db.prepare('UPDATE payables SET amount_paid = MAX(amount_paid - ?, 0) WHERE id = ?').run(record.amount, payableId);

    const nextLastPaidAt =
      db.prepare<{ paidAt: string | null }>(`
        SELECT paid_at as paidAt
        FROM payment_records
        WHERE payable_id = ?
        ORDER BY paid_at DESC, id DESC
        LIMIT 1
      `).get(payableId)?.paidAt ?? null;

    db.prepare('UPDATE payables SET last_paid_at = ? WHERE id = ?').run(nextLastPaidAt, payableId);

    appendAuditLog('undo_pay_payable', 'payable', payableId, {
      paymentId,
      amount: record.amount,
      method: record.method,
    });
  });

  transaction();

  return getPayableDetail(payableId);
}

export function runFinanceDocumentSync() {
  return syncFinanceDocuments();
}
