import { appendAuditLog, db, nextDocumentId } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { advanceArrival, listArrivals } from '../arrival/arrival.service';
import {
  createCustomer,
  listCustomers,
  type CreateCustomerPayload,
} from '../customers/customers.service';
import {
  getPayableDetail,
  getReceivableDetail,
  listPayables,
  listReceivables,
  undoPaymentRecord,
  undoReceiptRecord,
  payPayable,
  receiveReceivable,
} from '../finance/finance.service';
import { confirmInbound, listInbounds } from '../inbound/inbound.service';
import {
  createOrder,
  updateOrderStatus,
  type CreateOrderPayload,
} from '../orders/orders.service';
import {
  createProcurementOrder,
  generateSuggestedPurchaseOrders,
  getProcurementSuggestions,
  type CreateProcurementOrderPayload,
} from '../procurement/procurement.service';
import { dispatchShipment, listShipments } from '../shipping/shipping.service';
import {
  createProduct,
  resolveActiveSupplierReference,
  type CreateProductPayload as CreateProductMasterDataPayload,
} from '../settings/settings.service';
import { applySensitiveMemoryPendingAction } from './memory-update.service';
import type { AiApproval, AiPendingAction, AiToolCallRecord } from './dto/tool.dto';
import {
  buildArrivalReply,
  buildInboundReply,
  buildOrderReply,
  buildPaymentReply,
  buildReceiptReply,
  buildShippingReply,
  summarizePaymentRecords,
  summarizeReceiptRecords,
} from './action-replies';
import {
  findReusablePendingAction,
  getPendingActionRow,
  insertPendingAction,
  markPendingActionCancelled,
  markPendingActionConfirmed,
  markPendingActionUndone,
  type PendingActionRow,
} from './repositories/pending-action.repository';

const ARRIVAL_ID_REGEX = /RCV-\d{8}-\d+/i;
const INBOUND_ID_REGEX = /INB-\d{8}-\d+/i;
const SHIPMENT_ID_REGEX = /SHP-\d{8}-\d+/i;
const ORDER_ID_REGEX = /ORD-\d{8}-\d+/i;
const PURCHASE_ORDER_ID_REGEX = /PO-\d{8}-\d+/i;
const RECEIVABLE_ID_REGEX = /AR-\d{8}-\d+/i;
const PAYABLE_ID_REGEX = /AP-\d{8}-\d+/i;

const WRITE_PERMISSION_GUIDE: Record<string, { label: string; suggestion: string }> = {
  'settings.master-data': {
    label: '基础资料维护',
    suggestion: '通常由系统管理员或基础资料管理员持有。',
  },
  'procurement.manage': {
    label: '采购管理',
    suggestion: '通常由系统管理员、采购主管或采购专员持有。',
  },
  'shipping.dispatch': {
    label: '发货执行',
    suggestion: '通常由系统管理员、仓储主管或发货专员持有。',
  },
  'finance.receivable': {
    label: '应收收款',
    suggestion: '通常由系统管理员或财务岗位持有。',
  },
  'finance.payable': {
    label: '应付付款',
    suggestion: '通常由系统管理员或财务岗位持有。',
  },
  'orders.create': {
    label: '订单创建',
    suggestion: '通常由系统管理员、销售内勤或订单专员持有。',
  },
};

const WRITE_TOOL_NAMES = new Set<WriteToolName>([
  'create_customer_profile',
  'create_product_master_data',
  'generate_shortage_procurement',
  'advance_arrival_status',
  'confirm_inbound',
  'dispatch_shipping',
  'register_receipt',
  'register_payment',
  'create_sales_order',
  'create_procurement_order',
]);

const UNDOABLE_WRITE_TOOL_NAMES = new Set<WriteToolName>([
  'create_customer_profile',
  'register_receipt',
  'register_payment',
  'create_sales_order',
]);

export type WriteToolName =
  | 'create_customer_profile'
  | 'create_product_master_data'
  | 'generate_shortage_procurement'
  | 'advance_arrival_status'
  | 'confirm_inbound'
  | 'dispatch_shipping'
  | 'register_receipt'
  | 'register_payment'
  | 'create_sales_order'
  | 'create_procurement_order';

interface PendingActionPayloadMap {
  create_customer_profile: CreateCustomerPayload;
  create_product_master_data: CreateProductMasterDataPayload & {
    preferredSupplierName: string;
  };
  generate_shortage_procurement: {
    lowStockItemCount: number;
    recommendedOrderCount: number;
    recommendedSkus: string[];
  };
  advance_arrival_status: {
    arrivalId: string;
    poId: string;
    supplier: string;
    previousStatus: string;
    nextStatus: string;
  };
  confirm_inbound: {
    inboundId: string;
    receivingNoteId: string;
    supplier: string;
    itemCount: number;
    warehouse: string;
    previousStatus: string;
  };
  dispatch_shipping: {
    deliveryId: string;
    orderId: string;
    customer: string;
    itemCount: number;
    stockStatus: string;
    previousStatus: string;
  };
  register_receipt: {
    receivableId: string;
    orderId: string;
    customer: string;
    amountDue: number;
    amountPaidBefore: number;
    amount: number;
    remainingAmount: number;
    projectedAmountPaid: number;
    projectedRemainingAmount: number;
    projectedStatus: string;
    method: string;
    remark?: string;
  };
  register_payment: {
    payableId: string;
    purchaseOrderId: string;
    supplier: string;
    amountDue: number;
    amountPaidBefore: number;
    amount: number;
    remainingAmount: number;
    projectedAmountPaid: number;
    projectedRemainingAmount: number;
    projectedStatus: string;
    method: string;
    remark?: string;
  };
  create_sales_order: CreateOrderPayload;
  create_procurement_order: CreateProcurementOrderPayload;
}

interface PendingActionExecutionResultMap {
  create_customer_profile:
    | {
        mode: 'created';
        customerId: string;
      }
    | {
        mode: 'restored';
        customerId: string;
        previous: {
          channelPreference: string | null;
          contactName: string | null;
          phone: string | null;
          status: string;
        };
      };
  register_receipt: {
    receivableId: string;
    receiptId: string;
  };
  register_payment: {
    payableId: string;
    paymentId: string;
  };
  create_sales_order: {
    orderId: string;
  };
  create_procurement_order: {
    purchaseOrderId: string;
  };
}

interface WriteActionPlanningRequest {
  prompt: string;
  userId: string;
  username: string;
  permissions: string[];
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: AiToolCallRecord[];
    pendingActionId?: string;
    pendingActionName?: string;
    pendingActionStatus?: AiPendingAction['status'];
  }>;
}

export interface WriteActionPlanningResult {
  toolCalls: AiToolCallRecord[];
  toolContext: string;
  pendingAction?: AiPendingAction;
  replyHint?: string;
  usedConversationContext?: boolean;
}

export interface WriteActionExecutionResult {
  reply: string;
  toolCall: AiToolCallRecord;
  pendingAction: AiPendingAction;
  approval?: AiApproval;
  trace: string[];
}

const EXPIRY_MINUTES = 30;

function hasPermission(permissions: string[], permission: string) {
  return permissions.includes(permission);
}

function actionExpiresAt() {
  return new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000).toISOString();
}

function isPendingActionExpired(row: Pick<PendingActionRow, 'status' | 'expiresAt' | 'undoneAt'>) {
  return row.status === 'pending' && !row.undoneAt && row.expiresAt < new Date().toISOString();
}

function toPendingAction(row: PendingActionRow): AiPendingAction {
  return {
    id: row.id,
    name: row.actionName,
    summary: row.summary,
    confirmationMessage: row.confirmationMessage,
    status: row.undoneAt ? 'undone' : isPendingActionExpired(row) ? 'expired' : row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    canUndo: row.status === 'confirmed' && !row.undoneAt && row.undoSupported === 1,
    undoneAt: row.undoneAt || undefined,
  };
}

export function toApproval(action: AiPendingAction): AiApproval {
  return {
    id: action.id,
    kind: 'write_action',
    toolName: action.name,
    status: action.status,
    resumable: true,
    canConfirm: action.status === 'pending',
    canCancel: action.status === 'pending',
    canUndo: action.status === 'confirmed' && Boolean(action.canUndo),
    confirmPath: `/api/ai/actions/${action.id}/confirm`,
    cancelPath: `/api/ai/actions/${action.id}/cancel`,
    undoPath: `/api/ai/actions/${action.id}/undo`,
    expiresAt: action.expiresAt,
    summary: action.summary,
    confirmationMessage: action.confirmationMessage,
  };
}

function createPendingActionCore(input: {
  actionName: string;
  requiredPermission: string;
  payload: Record<string, unknown>;
  summary: string;
  confirmationMessage: string;
  userId: string;
  username: string;
  supersedePendingActionId?: string;
}) {
  const payloadJson = JSON.stringify(input.payload);
  const reusable = findReusablePendingAction(input.actionName, input.userId, payloadJson, new Date().toISOString());
  if (reusable) {
    return toPendingAction(reusable);
  }

  const createdAt = new Date().toISOString();
  const actionId = nextDocumentId('ai_pending_actions', 'AIACT', currentDateString());
  const expiresAt = actionExpiresAt();

  insertPendingAction({
    actionId,
    actionName: input.actionName,
    userId: input.userId,
    username: input.username,
    requiredPermission: input.requiredPermission,
    payloadJson,
    summary: input.summary,
    confirmationMessage: input.confirmationMessage,
    createdAt,
    expiresAt,
  });

  appendAuditLog('ai_action_planned', 'ai_action', actionId, {
    actionName: input.actionName,
    by: input.username,
    requiredPermission: input.requiredPermission,
  });

  if (input.supersedePendingActionId && input.supersedePendingActionId !== actionId) {
    supersedePendingAction(input.supersedePendingActionId, input.username, input.summary);
  }

  return {
    id: actionId,
    name: input.actionName,
    summary: input.summary,
    confirmationMessage: input.confirmationMessage,
    status: 'pending',
    createdAt,
    expiresAt,
  } as AiPendingAction;
}

export function planRuntimeWriteAction(input: {
  toolName: string;
  actionName: string;
  requiredPermission: string;
  payload: Record<string, unknown>;
  summary: string;
  confirmationMessage: string;
  userId: string;
  username: string;
  supersedePendingActionId?: string;
}) {
  const pendingAction = createPendingActionCore({
    actionName: input.actionName,
    requiredPermission: input.requiredPermission,
    payload: input.payload,
    summary: input.summary,
    confirmationMessage: input.confirmationMessage,
    userId: input.userId,
    username: input.username,
    supersedePendingActionId: input.supersedePendingActionId,
  });
  const approval = toApproval(pendingAction);
  const toolCall: AiToolCallRecord = {
    name: input.toolName,
    status: 'awaiting_confirmation',
    summary: pendingAction.summary,
  };

  return {
    pendingAction,
    approval,
    toolCall,
  };
}

function supersedePendingAction(actionId: string, username: string, nextSummary: string) {
  const existing = getPendingActionRow(actionId);
  if (!existing || existing.status !== 'pending') {
    return;
  }

  const cancelledAt = new Date().toISOString();
  markPendingActionCancelled(actionId, cancelledAt);

  appendAuditLog('ai_action_superseded', 'ai_action', actionId, {
    by: username,
    nextSummary,
    cancelledAt,
  });
}

function parseExecutionResult<T extends keyof PendingActionExecutionResultMap>(
  row: PendingActionRow,
): PendingActionExecutionResultMap[T] | null {
  if (!row.executionResult) {
    return null;
  }

  try {
    return JSON.parse(row.executionResult) as PendingActionExecutionResultMap[T];
  } catch {
    return null;
  }
}

function buildExecutionTrace(lines: string[]) {
  return lines.filter(Boolean);
}

function ensurePendingActionAllowed(row: PendingActionRow, userId: string, permissions: string[]) {
  if (row.createdBy !== userId) {
    throw new Error('只能确认或取消自己发起的 AI 待确认操作');
  }

  if (row.status !== 'pending') {
    throw new Error('该待确认操作已处理，不能重复执行');
  }

  if (row.expiresAt < new Date().toISOString()) {
    throw new Error('该待确认操作已过期，请重新发起');
  }

  if (!hasPermission(permissions, row.requiredPermission)) {
    throw new Error(`Missing permission: ${row.requiredPermission}`);
  }
}

function findCustomerSnapshotByName(name: string) {
  return db.prepare<{
    id: string;
    status: string;
    channelPreference: string | null;
    contactName: string | null;
    phone: string | null;
  }>(`
    SELECT
      id,
      status,
      channel_preference as channelPreference,
      contact_name as contactName,
      phone
    FROM customers
    WHERE name = ?
  `).get(name);
}

function undoCustomerCreation(execution: PendingActionExecutionResultMap['create_customer_profile']) {
  if (execution.mode === 'created') {
    const customer = db.prepare<{
      id: string;
      totalOrders: number;
      totalSales: number;
      status: string;
    }>(`
      SELECT
        id,
        total_orders as totalOrders,
        total_sales as totalSales,
        status
      FROM customers
      WHERE id = ?
    `).get(execution.customerId);

    if (!customer) {
      throw new Error('客户档案不存在，无法撤回');
    }

    if (customer.totalOrders > 0 || customer.totalSales > 0) {
      throw new Error('该客户档案已经产生业务数据，不能自动撤回');
    }

    db.prepare("UPDATE customers SET status = 'deleted' WHERE id = ?").run(execution.customerId);
    appendAuditLog('undo_create_customer', 'customer', execution.customerId, {
      mode: execution.mode,
    });
    return `已撤回：客户档案 ${execution.customerId} 已删除回滚。`;
  }

  const customer = db.prepare<{
    id: string;
    totalOrders: number;
    totalSales: number;
  }>(`
    SELECT
      id,
      total_orders as totalOrders,
      total_sales as totalSales
    FROM customers
    WHERE id = ?
  `).get(execution.customerId);

  if (!customer) {
    throw new Error('客户档案不存在，无法撤回');
  }

  if (customer.totalOrders > 0 || customer.totalSales > 0) {
    throw new Error('该客户档案已经产生业务数据，不能自动撤回');
  }

  db.prepare(
    `UPDATE customers
     SET status = ?, channel_preference = ?, contact_name = ?, phone = ?
     WHERE id = ?`
  ).run(
    execution.previous.status,
    execution.previous.channelPreference,
    execution.previous.contactName,
    execution.previous.phone,
    execution.customerId,
  );

  appendAuditLog('undo_restore_customer', 'customer', execution.customerId, {
    mode: execution.mode,
  });
  return `已撤回：客户档案 ${execution.customerId} 已恢复为删除前状态。`;
}

export function getPendingAction(actionId: string, userId: string) {
  const row = getPendingActionRow(actionId);
  if (!row) {
    throw new Error('待确认操作不存在');
  }

  if (row.createdBy !== userId) {
    throw new Error('只能查看自己发起的 AI 待确认操作');
  }

  return toPendingAction(row);
}

function ensureUndoActionAllowed(row: PendingActionRow, userId: string, permissions: string[]) {
  if (row.createdBy !== userId) {
    throw new Error('只能撤回自己发起并执行的 AI 操作');
  }

  if (row.status !== 'confirmed') {
    throw new Error('当前只有已执行的 AI 操作才能撤回');
  }

  if (row.undoneAt) {
    throw new Error('该 AI 操作已经撤回，不能重复执行');
  }

  if (row.undoSupported !== 1) {
    throw new Error('该 AI 操作当前不支持自动撤回');
  }

  if (!hasPermission(permissions, row.requiredPermission)) {
    throw new Error(`Missing permission: ${row.requiredPermission}`);
  }
}

export function confirmPendingAction(actionId: string, userId: string, username: string, permissions: string[]): WriteActionExecutionResult {
  const row = getPendingActionRow(actionId);
  if (!row) {
    throw new Error('待确认操作不存在');
  }

  if (isPendingActionExpired(row)) {
    const expiredAction = toPendingAction(row);
    return {
      reply: '该待确认操作已过期，不能再执行。请重新发起新的 AI 操作。',
      toolCall: {
        name: row.actionName,
        status: 'cancelled',
        summary: '该待确认动作已过期，未执行任何写入。',
      },
      pendingAction: expiredAction,
      approval: toApproval(expiredAction),
      trace: buildExecutionTrace([
        `读取待确认动作：${row.id}`,
        '动作已过期，已阻止执行。',
      ]),
    };
  }

  ensurePendingActionAllowed(row, userId, permissions);

  let reply = '';
  let summary = '';
  let executionResult: PendingActionExecutionResultMap[keyof PendingActionExecutionResultMap] | null = null;
  const trace = buildExecutionTrace([
    `读取待确认动作：${row.id}`,
    `权限校验通过：${row.requiredPermission}`,
  ]);

  if (row.actionName === 'generate_shortage_procurement') {
    const created = generateSuggestedPurchaseOrders();
    summary = created.length > 0 ? `已生成 ${created.length} 张补货采购单。` : '当前没有需要生成的补货采购单。';
    trace.push(`执行补货采购生成：新增 ${created.length} 张采购单`);
    reply =
      created.length > 0
        ? [
            `已确认并执行：${summary}`,
            ...created.map((item) => `- ${item.id} | ${item.supplier} | ${item.amount} | ${item.status}`),
          ].join('\n')
        : '已确认执行，但当前库存状态下没有新增采购单。';
  } else if (row.actionName === 'create_customer_profile') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['create_customer_profile'];
    const previousSnapshot = findCustomerSnapshotByName(payload.name.trim());
    const customer = createCustomer(payload);
    executionResult =
      previousSnapshot?.status === 'deleted'
        ? {
            mode: 'restored',
            customerId: customer.id,
            previous: {
              channelPreference: previousSnapshot.channelPreference,
              contactName: previousSnapshot.contactName,
              phone: previousSnapshot.phone,
              status: previousSnapshot.status,
            },
          }
        : {
            mode: 'created',
            customerId: customer.id,
          };
    summary = `已创建客户档案 ${customer.name}。`;
    trace.push(`执行客户档案创建：${customer.id}`);
    reply = [
      '已确认并执行：客户档案创建完成。',
      `- 客户编号：${customer.id}`,
      `- 客户名称：${customer.name}`,
      `- 渠道偏好：${customer.channelPreference}`,
      `- 联系人：${customer.contactName || '-'}`,
      `- 电话：${customer.phone || '-'}`,
    ].join('\n');
  } else if (row.actionName === 'create_product_master_data') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['create_product_master_data'];
    const product = createProduct({
      sku: payload.sku,
      name: payload.name,
      category: payload.category,
      unit: payload.unit,
      safeStock: payload.safeStock,
      salePrice: payload.salePrice,
      costPrice: payload.costPrice,
      preferredSupplierId: payload.preferredSupplierId,
    });
    summary = `已创建商品档案 ${product.sku}。`;
    trace.push(`执行商品档案创建：${product.id}`);
    reply = [
      '已确认并执行：商品档案创建完成。',
      `- 商品编号：${product.id}`,
      `- SKU：${product.sku}`,
      `- 商品名称：${product.name}`,
      `- 品类：${product.category}`,
      `- 默认供应商：${product.preferredSupplier}`,
    ].join('\n');
  } else if (row.actionName === 'advance_arrival_status') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['advance_arrival_status'];
    const arrival = advanceArrival(payload.arrivalId);
    summary = `已将到货单 ${arrival.id} 推进到 ${arrival.status}。`;
    trace.push(`推进到货单状态：${arrival.id} -> ${arrival.status}`);
    reply = buildArrivalReply(arrival);
  } else if (row.actionName === 'confirm_inbound') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['confirm_inbound'];
    const inbound = confirmInbound(payload.inboundId);
    summary = `已完成入库单 ${inbound.id}。`;
    trace.push(`确认入库单：${inbound.id}`);
    reply = buildInboundReply(inbound);
  } else if (row.actionName === 'dispatch_shipping') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['dispatch_shipping'];
    const shipment = dispatchShipment(payload.deliveryId);
    summary = `已完成发货单 ${shipment.id}。`;
    trace.push(`确认发货单：${shipment.id}`);
    reply = buildShippingReply(shipment);
  } else if (row.actionName === 'register_receipt') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['register_receipt'];
    const receivableMutation = receiveReceivable(payload.receivableId, {
      amount: payload.amount,
      method: payload.method,
      remark: payload.remark,
    });
    executionResult = {
      receivableId: payload.receivableId,
      receiptId: receivableMutation.latestReceiptId,
    };
    const receivable = getReceivableDetail(payload.receivableId);
    if (!receivable) {
      throw new Error('收款执行成功，但回读应收单详情失败');
    }
    summary = `已登记应收单 ${receivable.id} 收款 ${payload.amount.toFixed(2)} 元，当前剩余 ${receivable.remainingAmount.toFixed(2)} 元。`;
    trace.push(`登记收款：${payload.receivableId} / ${receivableMutation.latestReceiptId}`);
    reply = buildReceiptReply(receivable, payload.amount, payload.method);
  } else if (row.actionName === 'register_payment') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['register_payment'];
    const payableMutation = payPayable(payload.payableId, payload.amount, payload.method, payload.remark);
    executionResult = {
      payableId: payload.payableId,
      paymentId: payableMutation.latestPaymentId,
    };
    const payable = getPayableDetail(payload.payableId);
    if (!payable) {
      throw new Error('付款执行成功，但回读应付单详情失败');
    }
    summary = `已登记应付单 ${payable.id} 付款 ${payload.amount.toFixed(2)} 元，当前剩余 ${payable.remainingAmount.toFixed(2)} 元。`;
    trace.push(`登记付款：${payload.payableId} / ${payableMutation.latestPaymentId}`);
    reply = buildPaymentReply(payable, payload.amount, payload.method);
  } else if (row.actionName === 'create_sales_order') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['create_sales_order'];
    const order = createOrder(payload);
    executionResult = {
      orderId: order.id,
    };
    summary = `已创建订单 ${order.id}。`;
    trace.push(`创建销售订单：${order.id}`);
    reply = buildOrderReply(order, payload);
  } else if (row.actionName === 'create_procurement_order') {
    const payload = JSON.parse(row.payload) as PendingActionPayloadMap['create_procurement_order'];
    const procurement = createProcurementOrder(payload);
    executionResult = {
      purchaseOrderId: procurement.id,
    };
    summary = `已创建采购单 ${procurement.id}。`;
    trace.push(`创建采购单：${procurement.id}`);
    reply = [
      `已确认并执行：采购单 ${procurement.id} 创建完成。`,
      `- 供应商：${procurement.supplier}`,
      `- 预计到货：${procurement.expectedDate}`,
      `- 明细数量：${procurement.itemCount}`,
      `- 金额：${procurement.amount}`,
      `- 状态：${procurement.status}`,
    ].join('\n');
  } else if (
    row.actionName === 'update_profile_memory_sensitive' ||
    row.actionName === 'supersede_memory_fact_sensitive' ||
    row.actionName === 'delete_memory_fact_sensitive'
  ) {
    const payload = JSON.parse(row.payload) as {
      target: 'permissionPolicyNote' | 'financePolicyNote' | 'accountPolicyNote';
      newValue?: string;
      scopeType: 'global' | 'tenant' | 'user' | 'session';
      scopeId: string;
      tenantId?: string;
      userId?: string;
      sessionId?: string;
    };
    const sensitiveResult = applySensitiveMemoryPendingAction({
      actionName: row.actionName,
      payload,
      username,
    });
    summary = sensitiveResult.summary;
    reply = sensitiveResult.reply;
    trace.push(`执行高风险记忆动作：${row.actionName} / ${payload.target}`);
  } else {
    throw new Error('不支持的待确认操作');
  }

  const confirmedAt = new Date().toISOString();
  const undoSupported = UNDOABLE_WRITE_TOOL_NAMES.has(row.actionName as WriteToolName) && executionResult ? 1 : 0;
  markPendingActionConfirmed({
    actionId,
    confirmedAt,
    undoSupported,
    executionResultJson: executionResult ? JSON.stringify(executionResult) : null,
  });

  appendAuditLog('ai_action_confirmed', 'ai_action', actionId, {
    by: username,
    actionName: row.actionName,
    undoSupported: undoSupported === 1,
  });

  const updatedRow = getPendingActionRow(actionId);
  const confirmedAction = updatedRow ? toPendingAction(updatedRow) : { ...toPendingAction(row), status: 'confirmed' as const };
  trace.push(undoSupported === 1 ? '执行结果已记录，可在满足条件时撤回。' : '当前动作已执行，但不支持自动撤回。');

  return {
    reply,
    toolCall: {
      name: row.actionName,
      status: 'completed',
      summary,
    },
    pendingAction: confirmedAction,
    approval: toApproval(confirmedAction),
    trace,
  };
}

export function cancelPendingAction(actionId: string, userId: string, username: string, permissions: string[]): WriteActionExecutionResult {
  const row = getPendingActionRow(actionId);
  if (!row) {
    throw new Error('待确认操作不存在');
  }

  if (row.createdBy !== userId) {
    throw new Error('只能确认或取消自己发起的 AI 待确认操作');
  }

  if (isPendingActionExpired(row)) {
    const expiredAction = toPendingAction(row);
    return {
      reply: '该待确认操作已过期，已自动标记为失效。',
      toolCall: {
        name: row.actionName,
        status: 'cancelled',
        summary: '该待确认动作已过期，未执行任何写入。',
      },
      pendingAction: expiredAction,
      approval: toApproval(expiredAction),
      trace: buildExecutionTrace([
        `读取待确认动作：${row.id}`,
        '动作已过期，已自动收口为失效状态。',
      ]),
    };
  }

  ensurePendingActionAllowed(row, userId, permissions);

  markPendingActionCancelled(actionId, new Date().toISOString());

  appendAuditLog('ai_action_cancelled', 'ai_action', actionId, {
    by: username,
    actionName: row.actionName,
  });

  const updatedRow = getPendingActionRow(actionId);
  const cancelledAction = updatedRow ? toPendingAction(updatedRow) : { ...toPendingAction(row), status: 'cancelled' as const };
  return {
    reply: `已取消待确认操作：${row.summary}`,
    toolCall: {
      name: row.actionName,
      status: 'cancelled',
      summary: '已取消，本次不会执行任何写入。',
    },
    pendingAction: cancelledAction,
    approval: toApproval(cancelledAction),
    trace: buildExecutionTrace([
      `读取待确认动作：${row.id}`,
      `权限校验通过：${row.requiredPermission}`,
      '已取消，未执行任何写入。',
    ]),
  };
}

export function undoConfirmedAction(actionId: string, userId: string, username: string, permissions: string[]): WriteActionExecutionResult {
  const row = getPendingActionRow(actionId);
  if (!row) {
    throw new Error('待撤回操作不存在');
  }

  ensureUndoActionAllowed(row, userId, permissions);

  let reply = '';
  let summary = '';
  const trace = buildExecutionTrace([
    `读取已执行动作：${row.id}`,
    `权限校验通过：${row.requiredPermission}`,
  ]);

  if (row.actionName === 'create_customer_profile') {
    const execution = parseExecutionResult<'create_customer_profile'>(row);
    if (!execution) {
      throw new Error('缺少客户档案创建的执行记录，无法撤回');
    }
    reply = undoCustomerCreation(execution);
    summary = `已撤回客户档案操作 ${row.id}。`;
    trace.push(`回滚客户档案：${execution.customerId}`);
  } else if (row.actionName === 'register_receipt') {
    const execution = parseExecutionResult<'register_receipt'>(row);
    if (!execution) {
      throw new Error('缺少收款执行记录，无法撤回');
    }
    const receivable = undoReceiptRecord(execution.receivableId, execution.receiptId);
    if (!receivable) {
      throw new Error('撤回收款成功，但回读应收单详情失败');
    }
    summary = `已撤回应收单 ${execution.receivableId} 的收款记录 ${execution.receiptId}。`;
    trace.push(`回滚收款记录：${execution.receiptId}`);
    reply = [
      `已撤回：应收单 ${receivable.id} 最近一笔收款记录已回滚。`,
      `- 收款记录：${execution.receiptId}`,
      `- 当前累计已收：${receivable.amountPaid.toFixed(2)}`,
      `- 当前剩余应收：${receivable.remainingAmount.toFixed(2)}`,
      `- 当前状态：${receivable.status}`,
    ].join('\n');
  } else if (row.actionName === 'register_payment') {
    const execution = parseExecutionResult<'register_payment'>(row);
    if (!execution) {
      throw new Error('缺少付款执行记录，无法撤回');
    }
    const payable = undoPaymentRecord(execution.payableId, execution.paymentId);
    if (!payable) {
      throw new Error('撤回付款成功，但回读应付单详情失败');
    }
    summary = `已撤回应付单 ${execution.payableId} 的付款记录 ${execution.paymentId}。`;
    trace.push(`回滚付款记录：${execution.paymentId}`);
    reply = [
      `已撤回：应付单 ${payable.id} 最近一笔付款记录已回滚。`,
      `- 付款记录：${execution.paymentId}`,
      `- 当前累计已付：${payable.amountPaid.toFixed(2)}`,
      `- 当前剩余应付：${payable.remainingAmount.toFixed(2)}`,
      `- 当前状态：${payable.status}`,
    ].join('\n');
  } else if (row.actionName === 'create_sales_order') {
    const execution = parseExecutionResult<'create_sales_order'>(row);
    if (!execution) {
      throw new Error('缺少订单执行记录，无法撤回');
    }
    const order = updateOrderStatus(execution.orderId, '已取消');
    summary = `已撤回新建订单 ${execution.orderId}，订单已取消。`;
    trace.push(`回滚新建订单：${execution.orderId}`);
    reply = [
      `已撤回：订单 ${order.id} 已取消。`,
      `- 客户：${order.customerName}`,
      `- 当前状态：${order.status}`,
      `- 库存状态：${order.stockStatus}`,
    ].join('\n');
  } else {
    throw new Error('该 AI 写操作暂不支持撤回');
  }

  const undoneAt = new Date().toISOString();
  markPendingActionUndone(actionId, undoneAt);

  appendAuditLog('ai_action_undone', 'ai_action', actionId, {
    by: username,
    actionName: row.actionName,
  });

  const updatedRow = getPendingActionRow(actionId);
  const undoneAction = updatedRow ? toPendingAction(updatedRow) : { ...toPendingAction(row), status: 'undone' as const, canUndo: false, undoneAt };
  trace.push('撤回完成，原始执行记录已标记为已撤回。');

  return {
    reply,
    toolCall: {
      name: row.actionName,
      status: 'reverted',
      summary,
    },
    pendingAction: undoneAction,
    approval: toApproval(undoneAction),
    trace,
  };
}









