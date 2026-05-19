import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { requirePermission } from '../../shared/auth';
import { fail, ok } from '../../shared/response';
import { paginateList } from '../../shared/paginate';
import {
  getFinanceOverview,
  getPayableDetail,
  getReceivableDetail,
  listPayables,
  listPaymentRecords,
  listReceivables,
  listReceiptRecords,
  payPayable,
  receiveReceivable,
  runFinanceDocumentSync,
} from './finance.service';

export const financeRouter = Router();
const requireFinanceRead = requirePermission('finance.view');

financeRouter.get('/summary', requireFinanceRead, (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('finance'),
    summary: {
      existingUi: ['应收列表', '应付列表', '收付款登记'],
      plannedEntities: ['receivable', 'receipt_record', 'payable', 'payment_record'],
      nextMilestones: ['补账单核销明细', '补对账单导出', '补发票台账'],
    },
  });
});

financeRouter.get('/overview', requireFinanceRead, (_req, res) => {
  return ok(res, getFinanceOverview());
});

financeRouter.get('/receivables', requireFinanceRead, (req, res) => {
  return ok(res, paginateList(req, () => listReceivables(), {
    searchFields: ['id', 'orderId', 'customer'],
    filters: [
      { queryKey: 'customer', field: 'customer' },
      { queryKey: 'status', field: 'status' },
    ],
    rangeFilters: [
      { minKey: 'dueDateFrom', maxKey: 'dueDateTo', field: 'dueDate', type: 'date' },
      { minKey: 'amountMin', maxKey: 'amountMax', field: 'amountDue', type: 'number' },
      { minKey: 'remainingMin', maxKey: 'remainingMax', field: 'remainingAmount', type: 'number' },
    ],
  }));
});

financeRouter.get('/receivables/:id', requireFinanceRead, (_req, res) => {
  const detail = getReceivableDetail(_req.params.id);
  if (!detail) {
    return fail(res, 404, 'Receivable not found');
  }

  return ok(res, detail);
});

financeRouter.get('/receipts', requireFinanceRead, (_req, res) => {
  const receivableId = typeof _req.query.receivableId === 'string' ? _req.query.receivableId : undefined;
  return ok(res, listReceiptRecords(receivableId));
});

financeRouter.get('/payables', requireFinanceRead, (req, res) => {
  return ok(res, paginateList(req, () => listPayables(), {
    searchFields: ['id', 'purchaseOrderId', 'supplier'],
    filters: [
      { queryKey: 'supplier', field: 'supplier' },
      { queryKey: 'status', field: 'status' },
    ],
    rangeFilters: [
      { minKey: 'dueDateFrom', maxKey: 'dueDateTo', field: 'dueDate', type: 'date' },
      { minKey: 'amountMin', maxKey: 'amountMax', field: 'amountDue', type: 'number' },
      { minKey: 'remainingMin', maxKey: 'remainingMax', field: 'remainingAmount', type: 'number' },
    ],
  }));
});

financeRouter.get('/payables/:id', requireFinanceRead, (_req, res) => {
  const detail = getPayableDetail(_req.params.id);
  if (!detail) {
    return fail(res, 404, 'Payable not found');
  }

  return ok(res, detail);
});

financeRouter.get('/payments', requireFinanceRead, (_req, res) => {
  const payableId = typeof _req.query.payableId === 'string' ? _req.query.payableId : undefined;
  return ok(res, listPaymentRecords(payableId));
});

financeRouter.post('/receivables/:id/receive', requirePermission('finance.receivable'), (req, res) => {
  const amount = Number(req.body?.amount);
  const method = typeof req.body?.method === 'string' ? req.body.method : '银行转账';
  const remark = typeof req.body?.remark === 'string' ? req.body.remark : undefined;
  const items = Array.isArray(req.body?.items)
    ? req.body.items
        .map((item) => ({
          salesOrderItemId: typeof item?.salesOrderItemId === 'string' ? item.salesOrderItemId : '',
          amount: Number(item?.amount),
        }))
        .filter((item) => item.salesOrderItemId)
    : undefined;

  if ((!items || items.length === 0) && (!Number.isFinite(amount) || amount <= 0)) {
    return fail(res, 400, 'amount or items must contain a positive value');
  }

  try {
    const receivable = receiveReceivable(req.params.id, {
      amount: Number.isFinite(amount) && amount > 0 ? amount : undefined,
      method,
      remark,
      items,
    });
    return ok(res, receivable, '收款已登记。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Receive receivable failed');
  }
});

financeRouter.post('/payables/:id/pay', requirePermission('finance.payable'), (req, res) => {
  const amount = Number(req.body?.amount);
  const method = typeof req.body?.method === 'string' ? req.body.method : '对公转账';
  const remark = typeof req.body?.remark === 'string' ? req.body.remark : undefined;

  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(res, 400, 'amount must be a positive number');
  }

  try {
    const payable = payPayable(req.params.id, amount, method, remark);
    return ok(res, payable, '付款已登记。');
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Pay payable failed');
  }
});

financeRouter.post('/sync-documents', requirePermission('settings.access-control'), (_req, res) => {
  const result = runFinanceDocumentSync();
  return ok(res, result, `财务单据同步完成：新增应收 ${result.receivablesCreated} 条，新增应付 ${result.payablesCreated} 条。`);
});
