import { appendAuditLog, db, nextDocumentId } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { advanceArrival, listArrivals } from '../arrival/arrival.service';
import {
  createCustomer,
  importCustomers,
  listCustomers,
  type CreateCustomerPayload,
  type ImportSourceRow as CustomerImportSourceRow,
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
  importOrders,
  updateOrderStatus,
  type CreateOrderPayload,
  type ImportSourceRow as OrderImportSourceRow,
} from '../orders/orders.service';
import { generateSuggestedPurchaseOrders, getProcurementSuggestions } from '../procurement/procurement.service';
import { dispatchShipment, listShipments } from '../shipping/shipping.service';
import {
  createProduct,
  importProducts,
  resolveActiveSupplierReference,
  type CreateProductPayload as CreateProductMasterDataPayload,
  type ImportSourceRow as ProductImportSourceRow,
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
import { buildDiffLine, hasPromptField, matchesWriteIntent } from './action-intent';
import {
  extractExpectedDeliveryDate,
  extractFieldByLabels,
  extractLabeledField,
  extractOrderItemsText,
  extractRegexId,
  parseExplicitAmount,
  parseMethod,
  wantsFullSettlement,
} from './action-prompt-utils';

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
  | 'create_sales_order';

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
}

interface ImportDocumentsBatchPayload {
  requiredPermissions: string[];
  operations: Array<{
    target: 'customer' | 'product' | 'order';
    fileName: string;
    rows: Array<Record<string, unknown>>;
  }>;
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
  import_documents_batch: {
    importedCount: number;
    summaries: string[];
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

function ensureAllRequiredPermissions(permissions: string[], requiredPermissions: string[]) {
  const missing = requiredPermissions.filter((permission) => !hasPermission(permissions, permission));
  if (missing.length > 0) {
    throw new Error(`Missing permission(s): ${missing.join(', ')}`);
  }
}

function executeImportDocumentsBatch(payload: ImportDocumentsBatchPayload, trace: string[]) {
  const summaries: string[] = [];
  for (const operation of payload.operations) {
    const rows = Array.isArray(operation.rows) ? operation.rows : [];
    if (rows.length === 0) {
      summaries.push(`${operation.fileName}: no rows, skipped`);
      continue;
    }

    if (operation.target === 'customer') {
      const result = importCustomers(rows as CustomerImportSourceRow[]);
      summaries.push(
        `${operation.fileName} -> customer imported: total=${result.totalCount}, created=${result.createdCount}, skipped=${result.skippedCount}, errors=${result.errorCount}`,
      );
      continue;
    }

    if (operation.target === 'product') {
      const result = importProducts(rows as ProductImportSourceRow[]);
      summaries.push(
        `${operation.fileName} -> product imported: total=${result.totalCount}, created=${result.createdCount}, skipped=${result.skippedCount}, errors=${result.errorCount}`,
      );
      continue;
    }

    const result = importOrders(rows as OrderImportSourceRow[]);
    summaries.push(
      `${operation.fileName} -> order imported: total=${result.totalCount}, created=${result.createdCount}, skipped=${result.skippedCount}, errors=${result.errorCount}`,
    );
  }

  trace.push(`执行批量导入：${payload.operations.length} 个文件`);
  return {
    summary: `已执行批量导入（${payload.operations.length} 个文件）`,
    reply: ['已确认并执行：附件导入完成。', ...summaries].join('\n'),
    executionResult: {
      importedCount: payload.operations.length,
      summaries,
    } as PendingActionExecutionResultMap['import_documents_batch'],
  };
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

function createPendingAction<T extends WriteToolName>(
  actionName: T,
  requiredPermission: string,
  payload: PendingActionPayloadMap[T],
  summary: string,
  confirmationMessage: string,
  userId: string,
  username: string,
  options?: {
    supersedePendingActionId?: string;
  },
) {
  return createPendingActionCore({
    actionName,
    requiredPermission,
    payload: payload as unknown as Record<string, unknown>,
    summary,
    confirmationMessage,
    userId,
    username,
    supersedePendingActionId: options?.supersedePendingActionId,
  });
}

export function createRuntimePendingAction(input: {
  actionName: string;
  requiredPermission: string;
  payload: Record<string, unknown>;
  summary: string;
  confirmationMessage: string;
  userId: string;
  username: string;
  supersedePendingActionId?: string;
}) {
  return createPendingActionCore(input);
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

function parseCustomerPayload(prompt: string) {
  const explicitName = extractLabeledField(prompt, ['客户名称', '客户名']);
  const inlineName = /(?:创建|新增|添加)(?:客户档案|客户)[：:\s]*([^，。；;\n]+?)(?=\s*(?:渠道偏好|渠道|联系人|联系电话|电话|手机号|手机|$))/.exec(prompt)?.[1]?.trim() || '';
  const channelPreference = extractLabeledField(prompt, ['渠道偏好', '渠道']);
  const contactName = extractLabeledField(prompt, ['联系人']);
  const phone = /(?:联系电话|电话|手机号|手机)[：:\s]*(1\d{10})/.exec(prompt)?.[1]?.trim() || '';
  const payload: Partial<CreateCustomerPayload> = {
    name: explicitName || inlineName,
    channelPreference,
  };

  if (contactName) {
    payload.contactName = contactName;
  }

  if (phone) {
    payload.phone = phone;
  }

  const missing: string[] = [];
  if (!payload.name) {
    missing.push('客户名称');
  }
  if (!payload.channelPreference) {
    missing.push('渠道偏好');
  }

  return {
    payload: payload as CreateCustomerPayload,
    missing,
  };
}

function parseCreateProductPayload(prompt: string) {
  const explicitSku = extractFieldByLabels(prompt, ['SKU', '商品编码', '商品编号', '货号'], ['商品名称', '商品', '品类', '分类', '单位', '安全库存', '售价', '成本价', '供应商', '备注']);
  const inlineSku = /(SKU-\d{4,})/i.exec(prompt)?.[1]?.toUpperCase() || '';
  const explicitName =
    extractFieldByLabels(prompt, ['商品名称', '品名'], ['品类', '分类', '单位', '安全库存', '售价', '成本价', '供应商', '备注']) ||
    /(?:商品)[：:\s]+([^，。；;\n]+?)(?=\s*(?:品类|分类|单位|安全库存|售价|成本价|供应商|备注|$))/.exec(prompt)?.[1]?.trim() ||
    '';
  const inlineName =
    /(?:创建|新增|添加|录入)(?:商品档案|商品)[：:\s]*([^，。；;\n]+?)(?=\s*(?:SKU|商品名称|品类|分类|单位|安全库存|售价|成本价|供应商|备注|$))/.exec(prompt)?.[1]?.trim() ||
    '';
  const name = explicitName || inlineName;
  const category = extractFieldByLabels(prompt, ['品类', '分类', '类目'], ['单位', '安全库存', '售价', '成本价', '供应商', '备注']) || '日用百货';
  const unit = extractFieldByLabels(prompt, ['单位'], ['安全库存', '售价', '成本价', '供应商', '备注']) || '件';
  const safeStockText = extractFieldByLabels(prompt, ['安全库存', '最低库存'], ['售价', '成本价', '供应商', '备注']);
  const salePriceText = extractFieldByLabels(prompt, ['售价', '销售价', '零售价'], ['成本价', '供应商', '备注']);
  const costPriceText = extractFieldByLabels(prompt, ['成本价', '采购价', '进价'], ['供应商', '备注']);
  const supplierReference = extractFieldByLabels(prompt, ['默认供应商', '供应商', '供应商名称'], ['备注']);
  const safeStock = safeStockText ? Number(safeStockText) : 30;
  const salePrice = salePriceText ? Number(salePriceText) : Number.NaN;
  const costPrice = costPriceText ? Number(costPriceText) : Number.NaN;
  const supplier = supplierReference ? resolveActiveSupplierReference(supplierReference) : null;

  const payload: Partial<PendingActionPayloadMap['create_product_master_data']> = {
    sku: (explicitSku || inlineSku || '').trim().toUpperCase(),
    name,
    category,
    unit,
    safeStock,
    salePrice,
    costPrice,
    preferredSupplierId: supplier?.id || '',
    preferredSupplierName: supplier?.name || supplierReference,
  };

  const missing: string[] = [];
  if (!payload.sku) {
    missing.push('SKU');
  }
  if (!payload.name) {
    missing.push('商品名称');
  }
  if (!Number.isInteger(payload.safeStock) || (payload.safeStock ?? -1) < 0) {
    missing.push('安全库存');
  }
  if (!Number.isFinite(payload.salePrice) || (payload.salePrice ?? 0) <= 0) {
    missing.push('售价');
  }
  if (!Number.isFinite(payload.costPrice) || (payload.costPrice ?? 0) <= 0) {
    missing.push('成本价');
  }
  if (!supplierReference) {
    missing.push('供应商');
  } else if (!supplier) {
    missing.push('启用中的供应商');
  }

  return {
    payload: payload as PendingActionPayloadMap['create_product_master_data'],
    missing,
    supplierReference,
    supplierFound: Boolean(supplier),
  };
}

function parseOrderItems(itemsText: string) {
  const parts = itemsText
    .split(/[，,；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const items: CreateOrderPayload['items'] = [];
  const invalidTokens: string[] = [];
  const missingSkus: string[] = [];

  for (const part of parts) {
    const matched = /(SKU-\d{4,})\s*(?:[*xX×]|数量)?\s*(\d+)/i.exec(part);
    if (!matched) {
      invalidTokens.push(part);
      continue;
    }

    const sku = matched[1].toUpperCase();
    const quantity = Number(matched[2]);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      invalidTokens.push(part);
      continue;
    }

    const product = db.prepare<{ name: string; salePrice: number }>("SELECT name, sale_price as salePrice FROM products WHERE sku = ? AND status = 'active'").get(sku);
    if (!product) {
      missingSkus.push(sku);
      continue;
    }

    items.push({
      sku,
      productName: product.name,
      quantity,
      unitPrice: product.salePrice,
    });
  }

  return {
    items,
    invalidTokens,
    missingSkus,
  };
}

function parseCreateOrderPayload(prompt: string) {
  const customerName =
    extractFieldByLabels(prompt, ['客户', '客户名称', '客户名'], ['渠道', '交付日期', '配送日期', '期望送达', '预计送达', '明细', '备注']) ||
    /(?:创建订单|新建订单|创建销售订单)[：:\s]*([^，。；;\n]+?)(?=\s*(?:渠道|交付日期|配送日期|期望送达|预计送达|明细|备注|$))/.exec(prompt)?.[1]?.trim() ||
    '';
  const orderChannel = extractFieldByLabels(prompt, ['渠道', '订单渠道'], ['交付日期', '配送日期', '期望送达', '预计送达', '明细', '备注']);
  const expectedDeliveryDate = extractExpectedDeliveryDate(prompt);
  const itemsText = extractOrderItemsText(prompt);
  const remark = extractFieldByLabels(prompt, ['备注']);
  const parsedItems = parseOrderItems(itemsText);
  const missing: string[] = [];

  if (!customerName) {
    missing.push('客户名称');
  }

  if (!orderChannel) {
    missing.push('渠道');
  }

  if (!expectedDeliveryDate) {
    missing.push('交付日期');
  }

  if (!itemsText) {
    missing.push('商品明细');
  } else if (parsedItems.items.length === 0 && parsedItems.invalidTokens.length === 0 && parsedItems.missingSkus.length === 0) {
    missing.push('商品明细');
  }

  return {
    payload: {
      customerName,
      orderChannel,
      expectedDeliveryDate,
      remark: remark || undefined,
      items: parsedItems.items,
    } as CreateOrderPayload,
    missing,
    invalidTokens: parsedItems.invalidTokens,
    missingSkus: parsedItems.missingSkus,
  };
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

function buildWriteIntentResult(
  toolName: WriteToolName,
  status: AiToolCallRecord['status'],
  summary: string,
  replyHint: string,
  toolContext = '',
): WriteActionPlanningResult {
  return {
    toolCalls: [{ name: toolName, status, summary }],
    toolContext,
    replyHint,
  };
}

function buildFollowUpIntentResult(
  toolName: WriteToolName,
  summary: string,
  question: string,
  recognized: Array<[string, string | number | undefined]>,
  example?: string,
): WriteActionPlanningResult {
  const lines = [
    '参数回问：',
    ...recognized
      .filter(([, value]) => value !== undefined && String(value).trim() !== '')
      .map(([label, value]) => `- 已识别 ${label}：${value}`),
    `- 还需补充：${question}`,
    ...(example ? [`- 参考格式：${example}`] : []),
  ];

  return buildWriteIntentResult(toolName, 'planned', summary, question, lines.join('\n'));
}

function buildConfirmationReplyHint(summary: string, impact: string) {
  return `${summary} ${impact} 如信息无误请确认；如需修改请重新发送参数。`;
}

function buildPermissionDeniedWriteResult(
  toolName: WriteToolName,
  permission: string,
  actionLabel: string,
  effect: string,
): WriteActionPlanningResult {
  const guide = WRITE_PERMISSION_GUIDE[permission];
  const label = guide?.label || permission;
  return buildWriteIntentResult(
    toolName,
    'disabled',
    `当前角色缺少 ${label} 权限（${permission}），不能执行“${actionLabel}”。`,
    `当前登录角色未分配 ${label} 权限（${permission}），因此不能执行“${actionLabel}”。该操作会${effect}。${guide?.suggestion || '如需继续，请联系管理员分配对应权限后重试。'}`,
  );
}

function getLatestPendingHistoryAction(request: WriteActionPlanningRequest, expectedToolName?: WriteToolName) {
  if (!request.history || request.history.length === 0) {
    return null;
  }

  for (let index = request.history.length - 1; index >= 0; index -= 1) {
    const turn = request.history[index];
    if (
      turn.role !== 'assistant' ||
      turn.pendingActionStatus !== 'pending' ||
      !turn.pendingActionId
    ) {
      continue;
    }

    const row = getPendingActionRow(turn.pendingActionId);
    if (
      !row ||
      row.createdBy !== request.userId ||
      row.status !== 'pending' ||
      row.expiresAt < new Date().toISOString()
    ) {
      continue;
    }

    if (expectedToolName && row.actionName !== expectedToolName) {
      continue;
    }

    return row;
  }

  return null;
}


function looksLikeWriteFollowUp(prompt: string) {
  const normalized = prompt.replace(/\s+/g, '').toLowerCase();
  if (!normalized) {
    return false;
  }

  const acknowledgementSignals = ['谢谢', '好的', '收到', '明白了', '行', 'ok'];
  if (acknowledgementSignals.some((keyword) => normalized === keyword || normalized.startsWith(keyword))) {
    return false;
  }

  const querySignals = [
    '帮我查',
    '帮我看',
    '查询',
    '查看',
    '看看',
    '什么',
    '哪些',
    '多少',
    '详情',
    '概览',
    '报表',
    '库存',
    '到货',
    '入库',
    '发货',
    '客户档案',
    '消息中心',
    '审计',
    '权限',
    '角色',
    '会话',
  ];

  if (querySignals.some((keyword) => normalized.includes(keyword))) {
    return false;
  }

  const followUpSignals = [
    '改成',
    '改为',
    '改到',
    '修改',
    '补充',
    '备注',
    '客户',
    '渠道',
    '交付日期',
    '明细',
    '电话',
    '联系人',
    '金额',
    'sku',
    '品类',
    '单位',
    '售价',
    '成本价',
    '供应商',
    '全部',
    '结清',
  ];

  if (followUpSignals.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  if (/\d{4}-\d{2}-\d{2}/.test(prompt) || /sku-\d{4,}/i.test(prompt) || /1\d{10}/.test(prompt)) {
    return true;
  }

  return normalized.length <= 24;
}

function resolveWritePlanningPrompt(request: WriteActionPlanningRequest) {
  const directNormalized = request.prompt.replace(/\s+/g, '').toLowerCase();
  if (matchesWriteIntent(directNormalized) || !request.history || request.history.length === 0) {
    return {
      prompt: request.prompt,
      usedConversationContext: false,
      forcedToolName: null as WriteToolName | null,
    };
  }

  if (!looksLikeWriteFollowUp(request.prompt)) {
    return {
      prompt: request.prompt,
      usedConversationContext: false,
      forcedToolName: null as WriteToolName | null,
    };
  }

  const pendingHistoryAction = getLatestPendingHistoryAction(request);
  if (pendingHistoryAction) {
    return {
      prompt: request.prompt,
      usedConversationContext: true,
      forcedToolName: pendingHistoryAction.actionName,
    };
  }

  for (let index = request.history.length - 1; index >= 0; index -= 1) {
    const turn = request.history[index];
    if (turn.role !== 'assistant') {
      continue;
    }

    const activeTool = (turn.toolCalls || []).find(
      (toolCall) =>
        WRITE_TOOL_NAMES.has(toolCall.name as WriteToolName) &&
        (toolCall.status === 'planned' || toolCall.status === 'awaiting_confirmation'),
    );

    if (!activeTool) {
      continue;
    }

    for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
      const previousTurn = request.history[userIndex];
      if (previousTurn.role !== 'user') {
        continue;
      }

      return {
        prompt: `${previousTurn.content}\n${request.prompt}`,
        usedConversationContext: true,
        forcedToolName: activeTool.name as WriteToolName,
      };
    }
  }

  return {
    prompt: request.prompt,
    usedConversationContext: false,
    forcedToolName: null as WriteToolName | null,
  };
}

function applyConversationResolution(result: WriteActionPlanningResult, usedConversationContext: boolean): WriteActionPlanningResult {
  if (!usedConversationContext || result.toolCalls.length === 0) {
    return result;
  }

  const prefix = '多轮参数澄清：已基于上一轮待补参数或待确认写操作继续解析。';
  return {
    ...result,
    usedConversationContext: true,
    toolContext: result.toolContext ? `${prefix}\n${result.toolContext}` : prefix,
    replyHint: result.replyHint ? `已基于上一轮待补参数继续解析。${result.replyHint}` : '已基于上一轮待补参数继续解析。',
  };
}

function buildGenerateProcurementPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'generate_shortage_procurement';
  const requiredPermission = 'procurement.manage';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '生成补货采购单', '真实创建采购单并影响后续到货、入库流程');
  }

  const suggestion = getProcurementSuggestions();
  if (suggestion.lowStockItemCount <= 0 || suggestion.recommendedOrderCount <= 0) {
    return buildWriteIntentResult(
      toolName,
      'completed',
      suggestion.message,
      suggestion.message,
      [
        '工具结果：缺货补货建议',
        `- 低库存商品数：${suggestion.lowStockItemCount}`,
        `- 建议采购单数：${suggestion.recommendedOrderCount}`,
        `- 结论：${suggestion.message}`,
      ].join('\n'),
    );
  }

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    {
      lowStockItemCount: suggestion.lowStockItemCount,
      recommendedOrderCount: suggestion.recommendedOrderCount,
      recommendedSkus: suggestion.recommendedSkus,
    },
    `待确认生成 ${suggestion.recommendedOrderCount} 张补货采购单，覆盖 ${suggestion.lowStockItemCount} 个低库存商品。`,
    `将基于当前低库存情况生成 ${suggestion.recommendedOrderCount} 张补货采购单。确认后会真实写入采购单并记录审计日志。`,
    request.userId,
    request.username,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：生成缺货补货采购单',
      `- 低库存商品数：${suggestion.lowStockItemCount}`,
      `- 建议采购单数：${suggestion.recommendedOrderCount}`,
      `- 建议 SKU：${suggestion.recommendedSkus.join('、') || '-'}`,
      '- 执行影响：会真实生成采购单并写入审计日志。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实创建采购单。'),
  };
}

function buildCreateCustomerPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'create_customer_profile';
  const requiredPermission = 'settings.master-data';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '创建客户档案', '新增客户主数据并影响后续订单建单');
  }

  const previousPendingAction = getLatestPendingHistoryAction(request, toolName);
  const previousPayload = previousPendingAction ? (JSON.parse(previousPendingAction.payload) as PendingActionPayloadMap['create_customer_profile']) : null;
  const parsed = parseCustomerPayload(request.prompt);
  const payload: CreateCustomerPayload = {
    name: parsed.payload.name || previousPayload?.name || '',
    channelPreference: parsed.payload.channelPreference || previousPayload?.channelPreference || '',
    contactName: parsed.payload.contactName || previousPayload?.contactName,
    phone: parsed.payload.phone || previousPayload?.phone,
  };
  const missing: string[] = [];
  if (!payload.name) {
    missing.push('客户名称');
  }
  if (!payload.channelPreference) {
    missing.push('渠道偏好');
  }

  if (missing.length > 0) {
    return buildFollowUpIntentResult(
      toolName,
      `已识别创建客户意图，但缺少：${missing.join('、')}。`,
      missing.join('、'),
      [
        ['客户名称', payload.name],
        ['渠道偏好', payload.channelPreference],
        ['联系人', payload.contactName],
        ['电话', payload.phone],
      ],
      '创建客户 华东便利店 渠道 门店补货 联系人 张三 电话 13800001234',
    );
  }

  const existing = listCustomers().find((item) => item.name === payload.name);
  if (existing) {
    return buildWriteIntentResult(
      toolName,
      'completed',
      `客户 ${existing.name} 已存在，无需重复创建。`,
      `客户 ${existing.name} 已存在，无需重复创建。`,
      [
        '工具结果：客户档案已存在',
        `- 客户编号：${existing.id}`,
        `- 客户名称：${existing.name}`,
        `- 渠道偏好：${existing.channelPreference}`,
        `- 联系人：${existing.contactName || '-'}`,
        `- 电话：${existing.phone || '-'}`,
      ].join('\n'),
    );
  }

  const changeLines = previousPayload
    ? [
        buildDiffLine('客户名称', previousPayload.name, payload.name),
        buildDiffLine('渠道偏好', previousPayload.channelPreference, payload.channelPreference),
        buildDiffLine('联系人', previousPayload.contactName, payload.contactName),
        buildDiffLine('电话', previousPayload.phone, payload.phone),
      ].filter(Boolean)
    : [];

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    payload,
    previousPayload
      ? `待确认更新客户创建动作：${payload.name} / ${payload.channelPreference}`
      : `待确认创建客户档案：${payload.name} / ${payload.channelPreference}`,
    `将创建客户“${payload.name}”，渠道偏好为“${payload.channelPreference}”。确认后会真实写入客户档案并记录审计日志。${changeLines.length > 0 ? ` 本次调整：${changeLines.map((line) => line.replace('- 调整 ', '')).join('；')}` : ''}`,
    request.userId,
    request.username,
    previousPendingAction ? { supersedePendingActionId: previousPendingAction.id } : undefined,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：创建客户档案',
      ...(changeLines.length > 0 ? ['- 本次为更新已有待确认动作。', ...changeLines] : []),
      `- 客户名称：${payload.name}`,
      `- 渠道偏好：${payload.channelPreference}`,
      `- 联系人：${payload.contactName || '-'}`,
      `- 电话：${payload.phone || '-'}`,
      '- 执行影响：会新增客户档案，并写入审计日志。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实新增客户档案。'),
  };
}

function buildCreateProductMasterDataPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'create_product_master_data';
  const requiredPermission = 'settings.master-data';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '创建商品档案', '新增商品主数据并影响库存、采购与订单建单');
  }

  const previousPendingAction = getLatestPendingHistoryAction(request, toolName);
  const previousPayload = previousPendingAction ? (JSON.parse(previousPendingAction.payload) as PendingActionPayloadMap['create_product_master_data']) : null;
  const parsed = parseCreateProductPayload(request.prompt);
  const hasExplicitCategory = hasPromptField(request.prompt, ['品类', '分类', '类目']);
  const hasExplicitUnit = hasPromptField(request.prompt, ['单位']);
  const hasExplicitSafeStock = hasPromptField(request.prompt, ['安全库存', '最低库存']);
  const hasExplicitSalePrice = hasPromptField(request.prompt, ['售价', '销售价', '零售价']);
  const hasExplicitCostPrice = hasPromptField(request.prompt, ['成本价', '采购价', '进价']);
  const hasExplicitSupplier = hasPromptField(request.prompt, ['默认供应商', '供应商', '供应商名称']);

  const payload: PendingActionPayloadMap['create_product_master_data'] = {
    sku: parsed.payload.sku || previousPayload?.sku || '',
    name: parsed.payload.name || previousPayload?.name || '',
    category: hasExplicitCategory ? parsed.payload.category : previousPayload?.category || parsed.payload.category || '日用百货',
    unit: hasExplicitUnit ? parsed.payload.unit : previousPayload?.unit || parsed.payload.unit || '件',
    safeStock: hasExplicitSafeStock ? parsed.payload.safeStock : previousPayload?.safeStock ?? parsed.payload.safeStock ?? 30,
    salePrice: hasExplicitSalePrice ? parsed.payload.salePrice : previousPayload?.salePrice ?? parsed.payload.salePrice,
    costPrice: hasExplicitCostPrice ? parsed.payload.costPrice : previousPayload?.costPrice ?? parsed.payload.costPrice,
    preferredSupplierId: hasExplicitSupplier ? parsed.payload.preferredSupplierId : previousPayload?.preferredSupplierId || parsed.payload.preferredSupplierId || '',
    preferredSupplierName: hasExplicitSupplier ? parsed.payload.preferredSupplierName : previousPayload?.preferredSupplierName || parsed.payload.preferredSupplierName || '',
  };

  const missing: string[] = [];
  if (!payload.sku) {
    missing.push('SKU');
  }
  if (!payload.name) {
    missing.push('商品名称');
  }
  if (!Number.isInteger(payload.safeStock) || payload.safeStock < 0) {
    missing.push('安全库存');
  }
  if (!Number.isFinite(payload.salePrice) || payload.salePrice <= 0) {
    missing.push('售价');
  }
  if (!Number.isFinite(payload.costPrice) || payload.costPrice <= 0) {
    missing.push('成本价');
  }
  if (!payload.preferredSupplierId) {
    missing.push(parsed.supplierReference && !parsed.supplierFound ? '启用中的供应商' : '供应商');
  }

  if (missing.length > 0) {
    return buildFollowUpIntentResult(
      toolName,
      `已识别创建商品意图，但缺少：${missing.join('、')}。`,
      missing.join('、'),
      [
        ['SKU', payload.sku],
        ['商品名称', payload.name],
        ['品类', payload.category],
        ['单位', payload.unit],
        ['安全库存', payload.safeStock],
        ['售价', Number.isFinite(payload.salePrice) ? payload.salePrice.toFixed(2) : undefined],
        ['成本价', Number.isFinite(payload.costPrice) ? payload.costPrice.toFixed(2) : undefined],
        ['供应商', payload.preferredSupplierName],
      ],
      '创建商品 SKU SKU-2001 商品 维达湿巾 品类 纸品日化 单位 件 安全库存 30 售价 12.8 成本价 8.5 供应商 维达集团',
    );
  }

  const existing = db.prepare<{ id: string; name: string; status: string }>(
    'SELECT id, name, COALESCE(status, \'active\') as status FROM products WHERE sku = ?'
  ).get(payload.sku);
  if (existing) {
    return buildWriteIntentResult(
      toolName,
      'completed',
      `SKU ${payload.sku} 已存在，无需重复创建。`,
      `SKU ${payload.sku} 已存在，无需重复创建。`,
      [
        '工具结果：商品档案已存在',
        `- 商品编号：${existing.id}`,
        `- SKU：${payload.sku}`,
        `- 商品名称：${existing.name}`,
        `- 状态：${existing.status}`,
      ].join('\n'),
    );
  }

  const changeLines = previousPayload
    ? [
        buildDiffLine('SKU', previousPayload.sku, payload.sku),
        buildDiffLine('商品名称', previousPayload.name, payload.name),
        buildDiffLine('品类', previousPayload.category, payload.category),
        buildDiffLine('单位', previousPayload.unit, payload.unit),
        buildDiffLine('安全库存', previousPayload.safeStock, payload.safeStock),
        buildDiffLine('售价', previousPayload.salePrice, payload.salePrice),
        buildDiffLine('成本价', previousPayload.costPrice, payload.costPrice),
        buildDiffLine('供应商', previousPayload.preferredSupplierName, payload.preferredSupplierName),
      ].filter(Boolean)
    : [];

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    payload,
    previousPayload
      ? `待确认更新商品创建动作：${payload.sku} / ${payload.name}`
      : `待确认创建商品档案：${payload.sku} / ${payload.name}`,
    `将创建商品 ${payload.sku} · ${payload.name}，默认供应商为 ${payload.preferredSupplierName}，售价 ${payload.salePrice.toFixed(2)} 元，成本价 ${payload.costPrice.toFixed(2)} 元。确认后会真实写入商品档案并记录审计日志。${changeLines.length > 0 ? ` 本次调整：${changeLines.map((line) => line.replace('- 调整 ', '')).join('；')}` : ''}`,
    request.userId,
    request.username,
    previousPendingAction ? { supersedePendingActionId: previousPendingAction.id } : undefined,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：创建商品档案',
      ...(changeLines.length > 0 ? ['- 本次为更新已有待确认动作。', ...changeLines] : []),
      `- SKU：${payload.sku}`,
      `- 商品名称：${payload.name}`,
      `- 品类：${payload.category}`,
      `- 单位：${payload.unit}`,
      `- 安全库存：${payload.safeStock}`,
      `- 售价：${payload.salePrice.toFixed(2)}`,
      `- 成本价：${payload.costPrice.toFixed(2)}`,
      `- 默认供应商：${payload.preferredSupplierName}`,
      '- 执行影响：会新增商品档案，并自动在默认仓库初始化库存记录。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实新增商品档案。'),
  };
}

function buildAdvanceArrivalPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'advance_arrival_status';
  const requiredPermission = 'procurement.manage';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '推进到货验收', '更新到货状态并影响后续入库单');
  }

  const arrivalId = extractRegexId(request.prompt, ARRIVAL_ID_REGEX);
  const purchaseOrderId = extractRegexId(request.prompt, PURCHASE_ORDER_ID_REGEX);
  if (!arrivalId && !purchaseOrderId) {
    return buildFollowUpIntentResult(
      toolName,
      '已识别到货推进意图，但缺少到货单号。',
      '请提供明确的到货单号。',
      [
        ['到货单号', arrivalId],
        ['采购单号', purchaseOrderId],
      ],
      '推进到货单 RCV-20260311-001',
    );
  }

  const arrival = listArrivals().find((item) => item.id === arrivalId || item.poId === purchaseOrderId);
  if (!arrival) {
    return buildFollowUpIntentResult(
      toolName,
      '没有找到对应的到货单。',
      '请检查 `RCV-...` 或 `PO-...` 单号是否正确。',
      [
        ['到货单号', arrivalId],
        ['采购单号', purchaseOrderId],
      ],
      '推进到货单 RCV-20260311-001',
    );
  }

  if (arrival.status === '已验收待入库' || arrival.status === '已入库') {
    return buildWriteIntentResult(toolName, 'completed', `到货单 ${arrival.id} 当前状态为 ${arrival.status}，无需再次推进。`, `到货单 ${arrival.id} 当前状态为 ${arrival.status}，无需再次推进。`);
  }

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    {
      arrivalId: arrival.id,
      poId: arrival.poId,
      supplier: arrival.supplier,
      previousStatus: arrival.status,
      nextStatus: '已验收待入库',
    },
    `待确认推进到货单 ${arrival.id}：${arrival.status} -> 已验收待入库。`,
    `将把到货单 ${arrival.id} 从“${arrival.status}”推进到“已验收待入库”，并自动生成或更新待入库单。`,
    request.userId,
    request.username,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：推进到货验收',
      `- 到货单：${arrival.id}`,
      `- 采购单：${arrival.poId}`,
      `- 供应商：${arrival.supplier}`,
      `- 当前状态：${arrival.status}`,
      '- 目标状态：已验收待入库',
      '- 执行影响：会推进到货状态，并自动生成或更新待入库单。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会推进到货状态并影响后续入库。'),
  };
}

function buildConfirmInboundPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'confirm_inbound';
  const requiredPermission = 'procurement.manage';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '确认入库', '增加库存并影响可发货数量');
  }

  const inboundId = extractRegexId(request.prompt, INBOUND_ID_REGEX);
  const receivingNoteId = extractRegexId(request.prompt, ARRIVAL_ID_REGEX);
  if (!inboundId && !receivingNoteId) {
    return buildFollowUpIntentResult(
      toolName,
      '已识别入库确认意图，但缺少入库单号。',
      '请提供明确的入库单号。',
      [
        ['入库单号', inboundId],
        ['到货单号', receivingNoteId],
      ],
      '确认入库单 INB-20260311-001',
    );
  }

  const inbound = listInbounds().find((item) => item.id === inboundId || item.rcvId === receivingNoteId);
  if (!inbound) {
    return buildFollowUpIntentResult(
      toolName,
      '没有找到对应的入库单。',
      '请检查 `INB-...` 或 `RCV-...` 单号是否正确。',
      [
        ['入库单号', inboundId],
        ['到货单号', receivingNoteId],
      ],
      '确认入库单 INB-20260311-001',
    );
  }

  if (inbound.status === '已入库') {
    return buildWriteIntentResult(toolName, 'completed', `入库单 ${inbound.id} 已经完成入库。`, `入库单 ${inbound.id} 已经完成入库。`);
  }

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    {
      inboundId: inbound.id,
      receivingNoteId: inbound.rcvId,
      supplier: inbound.supplier,
      itemCount: inbound.items,
      warehouse: inbound.warehouse,
      previousStatus: inbound.status,
    },
    `待确认入库单 ${inbound.id}：${inbound.status} -> 已入库。`,
    `将把入库单 ${inbound.id} 确认入库，并同步增加仓库 ${inbound.warehouse} 的库存。`,
    request.userId,
    request.username,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：确认入库',
      `- 入库单：${inbound.id}`,
      `- 到货单：${inbound.rcvId}`,
      `- 供应商：${inbound.supplier}`,
      `- 入库数量：${inbound.items}`,
      `- 仓位：${inbound.warehouse}`,
      '- 执行影响：会确认入库并同步增加对应仓库库存。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实增加库存。'),
  };
}

function buildDispatchShippingPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'dispatch_shipping';
  const requiredPermission = 'shipping.dispatch';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '确认发货', '扣减库存、更新订单状态并生成物流信息');
  }

  const shipmentId = extractRegexId(request.prompt, SHIPMENT_ID_REGEX);
  const orderId = extractRegexId(request.prompt, ORDER_ID_REGEX);
  if (!shipmentId && !orderId) {
    return buildFollowUpIntentResult(
      toolName,
      '已识别发货确认意图，但缺少发货单号。',
      '请提供明确的发货单号。',
      [
        ['发货单号', shipmentId],
        ['订单号', orderId],
      ],
      '确认发货单 SHP-20260311-001',
    );
  }

  const shipment = listShipments().find((item) => item.id === shipmentId || item.orderId === orderId);
  if (!shipment) {
    return buildFollowUpIntentResult(
      toolName,
      '没有找到对应的发货单。',
      '请检查 `SHP-...` 或 `ORD-...` 单号是否正确。',
      [
        ['发货单号', shipmentId],
        ['订单号', orderId],
      ],
      '确认发货单 SHP-20260311-001',
    );
  }

  if (shipment.status === '已发货') {
    return buildWriteIntentResult(toolName, 'completed', `发货单 ${shipment.id} 已经发货。`, `发货单 ${shipment.id} 已经发货。`);
  }

  if (shipment.stockStatus !== '库存充足') {
    return buildWriteIntentResult(toolName, 'planned', `发货单 ${shipment.id} 当前库存状态为 ${shipment.stockStatus}，不能直接发货。`, `发货单 ${shipment.id} 当前库存状态为 ${shipment.stockStatus}，请先补货后再发货。`);
  }

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    {
      deliveryId: shipment.id,
      orderId: shipment.orderId,
      customer: shipment.customer,
      itemCount: shipment.items,
      stockStatus: shipment.stockStatus,
      previousStatus: shipment.status,
    },
    `待确认发货单 ${shipment.id}：${shipment.status} -> 已发货。`,
    `将把发货单 ${shipment.id} 确认发货，并同步扣减库存、生成物流单号。`,
    request.userId,
    request.username,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：确认发货',
      `- 发货单：${shipment.id}`,
      `- 订单号：${shipment.orderId}`,
      `- 客户：${shipment.customer}`,
      `- 件数：${shipment.items}`,
      `- 库存状态：${shipment.stockStatus}`,
      '- 执行影响：会扣减库存、更新订单状态并生成物流信息。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实扣减库存并生成物流信息。'),
  };
}

function buildRegisterReceiptPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'register_receipt';
  const requiredPermission = 'finance.receivable';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '登记收款', '新增收款记录并更新应收余额');
  }

  const previousPendingAction = getLatestPendingHistoryAction(request, toolName);
  const previousPayload = previousPendingAction ? (JSON.parse(previousPendingAction.payload) as PendingActionPayloadMap['register_receipt']) : null;
  const receivableId = extractRegexId(request.prompt, RECEIVABLE_ID_REGEX) || previousPayload?.receivableId || '';
  if (!receivableId) {
    return buildFollowUpIntentResult(
      toolName,
      '已识别收款登记意图，但缺少应收单号。',
      '请提供明确的应收单号。',
      [['应收单号', receivableId]],
      '登记收款 AR-20260311-001 金额 120',
    );
  }

  const receivable = listReceivables().find((item) => item.id === receivableId);
  if (!receivable) {
    return buildFollowUpIntentResult(
      toolName,
      '没有找到对应的应收单。',
      '请检查 `AR-...` 单号是否正确。',
      [['应收单号', receivableId]],
      '登记收款 AR-20260311-001 金额 120',
    );
  }

  if (receivable.remainingAmount <= 0) {
    return buildWriteIntentResult(toolName, 'completed', `应收单 ${receivable.id} 已经结清。`, `应收单 ${receivable.id} 已经结清。`);
  }

  const explicitAmount = wantsFullSettlement(request.prompt) ? receivable.remainingAmount : parseExplicitAmount(request.prompt, receivable.id);
  const amount = explicitAmount ?? previousPayload?.amount ?? null;
  if (amount === null) {
    return buildFollowUpIntentResult(
      toolName,
      `已识别收款登记意图，但缺少明确金额。当前应收单 ${receivable.id} 剩余 ${receivable.remainingAmount.toFixed(2)} 元。`,
      '请补充收款金额，或使用“全部/结清”。',
      [
        ['应收单号', receivable.id],
        ['客户', receivable.customer],
        ['当前剩余金额', receivable.remainingAmount.toFixed(2)],
      ],
      '登记收款 AR-20260311-001 金额 120',
    );
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > receivable.remainingAmount) {
    return buildFollowUpIntentResult(
      toolName,
      `收款金额无效。当前应收单 ${receivable.id} 剩余 ${receivable.remainingAmount.toFixed(2)} 元。`,
      '收款金额必须大于 0 且不超过剩余应收金额。',
      [
        ['应收单号', receivable.id],
        ['客户', receivable.customer],
        ['当前剩余金额', receivable.remainingAmount.toFixed(2)],
        ['本次收款金额', amount.toFixed(2)],
      ],
      '登记收款 AR-20260311-001 金额 120',
    );
  }

  const receiptMethodMappings = [
    { keywords: ['微信'], method: '微信收款' },
    { keywords: ['支付宝'], method: '支付宝' },
    { keywords: ['现金'], method: '现金' },
    { keywords: ['刷卡', 'pos'], method: 'POS 刷卡' },
    { keywords: ['对公'], method: '对公转账' },
    { keywords: ['银行'], method: '银行转账' },
  ];
  const hasMethodKeyword = receiptMethodMappings.some((mapping) => mapping.keywords.some((keyword) => request.prompt.toLowerCase().includes(keyword.toLowerCase())));
  const method = hasMethodKeyword
    ? parseMethod(request.prompt, receiptMethodMappings, previousPayload?.method || '银行转账')
    : previousPayload?.method || '银行转账';
  const remark = hasPromptField(request.prompt, ['备注']) ? extractFieldByLabels(request.prompt, ['备注']) : previousPayload?.remark;
  const receivableDetail = getReceivableDetail(receivable.id);
  const amountPaidBefore = receivable.amountPaid;
  const projectedAmountPaid = amountPaidBefore + amount;
  const projectedRemainingAmount = Math.max(receivable.amountDue - projectedAmountPaid, 0);
  const projectedStatus = projectedRemainingAmount <= 0 ? '已收款' : receivable.dueDate < currentDateString() ? '逾期' : '部分收款';
  const recentRecordsSummary = summarizeReceiptRecords(receivableDetail?.records ?? []);
  const changeLines = previousPayload
    ? [
        buildDiffLine('应收单号', previousPayload.receivableId, receivable.id),
        buildDiffLine('本次收款金额', previousPayload.amount.toFixed(2), amount.toFixed(2)),
        buildDiffLine('收款方式', previousPayload.method, method),
        buildDiffLine('备注', previousPayload.remark, remark),
      ].filter(Boolean)
    : [];

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    {
      receivableId: receivable.id,
      orderId: receivable.orderId,
      customer: receivable.customer,
      amountDue: receivable.amountDue,
      amountPaidBefore,
      amount,
      remainingAmount: receivable.remainingAmount,
      projectedAmountPaid,
      projectedRemainingAmount,
      projectedStatus,
      method,
      remark: remark || undefined,
    },
    previousPayload
      ? `待确认更新收款动作：${receivable.id} 本次 ${amount.toFixed(2)} 元，执行后剩余 ${projectedRemainingAmount.toFixed(2)} 元。`
      : `待确认登记收款：${receivable.id} 本次 ${amount.toFixed(2)} 元，执行后剩余 ${projectedRemainingAmount.toFixed(2)} 元。`,
    `将对客户 ${receivable.customer} 的应收单 ${receivable.id} 登记收款 ${amount.toFixed(2)} 元，方式为 ${method}；执行后累计已收 ${projectedAmountPaid.toFixed(2)} 元，剩余 ${projectedRemainingAmount.toFixed(2)} 元，状态预计为 ${projectedStatus}。${changeLines.length > 0 ? ` 本次调整：${changeLines.map((line) => line.replace('- 调整 ', '')).join('；')}` : ''}`,
    request.userId,
    request.username,
    previousPendingAction ? { supersedePendingActionId: previousPendingAction.id } : undefined,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：登记收款',
      ...(changeLines.length > 0 ? ['- 本次为更新已有待确认动作。', ...changeLines] : []),
      `- 应收单：${receivable.id}`,
      `- 订单号：${receivable.orderId}`,
      `- 客户：${receivable.customer}`,
      `- 应收总额：${receivable.amountDue.toFixed(2)}`,
      `- 当前已收：${amountPaidBefore.toFixed(2)}`,
      `- 当前剩余：${receivable.remainingAmount.toFixed(2)}`,
      `- 本次收款：${amount.toFixed(2)}`,
      `- 收款方式：${method}`,
      `- 执行后累计已收：${projectedAmountPaid.toFixed(2)}`,
      `- 执行后剩余：${projectedRemainingAmount.toFixed(2)}`,
      `- 执行后状态：${projectedStatus}`,
      `- 最近收款记录：${recentRecordsSummary}`,
      `- 备注：${remark || '-'}`,
      '- 执行影响：会新增收款记录、更新应收余额并可能改变应收状态。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实写入收款记录并更新应收状态。'),
  };
}

function buildRegisterPaymentPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'register_payment';
  const requiredPermission = 'finance.payable';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '登记付款', '新增付款记录并更新应付余额');
  }

  const previousPendingAction = getLatestPendingHistoryAction(request, toolName);
  const previousPayload = previousPendingAction ? (JSON.parse(previousPendingAction.payload) as PendingActionPayloadMap['register_payment']) : null;
  const payableId = extractRegexId(request.prompt, PAYABLE_ID_REGEX) || previousPayload?.payableId || '';
  if (!payableId) {
    return buildFollowUpIntentResult(
      toolName,
      '已识别付款登记意图，但缺少应付单号。',
      '请提供明确的应付单号。',
      [['应付单号', payableId]],
      '登记付款 AP-20260310-001 金额 300',
    );
  }

  const payable = listPayables().find((item) => item.id === payableId);
  if (!payable) {
    return buildFollowUpIntentResult(
      toolName,
      '没有找到对应的应付单。',
      '请检查 `AP-...` 单号是否正确。',
      [['应付单号', payableId]],
      '登记付款 AP-20260310-001 金额 300',
    );
  }

  if (payable.remainingAmount <= 0) {
    return buildWriteIntentResult(toolName, 'completed', `应付单 ${payable.id} 已经结清。`, `应付单 ${payable.id} 已经结清。`);
  }

  const explicitAmount = wantsFullSettlement(request.prompt) ? payable.remainingAmount : parseExplicitAmount(request.prompt, payable.id);
  const amount = explicitAmount ?? previousPayload?.amount ?? null;
  if (amount === null) {
    return buildFollowUpIntentResult(
      toolName,
      `已识别付款登记意图，但缺少明确金额。当前应付单 ${payable.id} 剩余 ${payable.remainingAmount.toFixed(2)} 元。`,
      '请补充付款金额，或使用“全部/结清”。',
      [
        ['应付单号', payable.id],
        ['供应商', payable.supplier],
        ['当前剩余金额', payable.remainingAmount.toFixed(2)],
      ],
      '登记付款 AP-20260310-001 金额 300',
    );
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > payable.remainingAmount) {
    return buildFollowUpIntentResult(
      toolName,
      `付款金额无效。当前应付单 ${payable.id} 剩余 ${payable.remainingAmount.toFixed(2)} 元。`,
      '付款金额必须大于 0 且不超过剩余应付金额。',
      [
        ['应付单号', payable.id],
        ['供应商', payable.supplier],
        ['当前剩余金额', payable.remainingAmount.toFixed(2)],
        ['本次付款金额', amount.toFixed(2)],
      ],
      '登记付款 AP-20260310-001 金额 300',
    );
  }

  const paymentMethodMappings = [
    { keywords: ['现金'], method: '现金' },
    { keywords: ['对公'], method: '对公转账' },
    { keywords: ['银行'], method: '银行转账' },
    { keywords: ['支付宝'], method: '支付宝' },
    { keywords: ['微信'], method: '微信付款' },
  ];
  const hasMethodKeyword = paymentMethodMappings.some((mapping) => mapping.keywords.some((keyword) => request.prompt.toLowerCase().includes(keyword.toLowerCase())));
  const method = hasMethodKeyword
    ? parseMethod(request.prompt, paymentMethodMappings, previousPayload?.method || '对公转账')
    : previousPayload?.method || '对公转账';
  const remark = hasPromptField(request.prompt, ['备注']) ? extractFieldByLabels(request.prompt, ['备注']) : previousPayload?.remark;
  const payableDetail = getPayableDetail(payable.id);
  const amountPaidBefore = payable.amountPaid;
  const projectedAmountPaid = amountPaidBefore + amount;
  const projectedRemainingAmount = Math.max(payable.amountDue - projectedAmountPaid, 0);
  const projectedStatus = projectedRemainingAmount <= 0 ? '已付款' : payable.dueDate < currentDateString() ? '逾期' : '部分付款';
  const recentRecordsSummary = summarizePaymentRecords(payableDetail?.records ?? []);
  const changeLines = previousPayload
    ? [
        buildDiffLine('应付单号', previousPayload.payableId, payable.id),
        buildDiffLine('本次付款金额', previousPayload.amount.toFixed(2), amount.toFixed(2)),
        buildDiffLine('付款方式', previousPayload.method, method),
        buildDiffLine('备注', previousPayload.remark, remark),
      ].filter(Boolean)
    : [];

  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    {
      payableId: payable.id,
      purchaseOrderId: payable.purchaseOrderId,
      supplier: payable.supplier,
      amountDue: payable.amountDue,
      amountPaidBefore,
      amount,
      remainingAmount: payable.remainingAmount,
      projectedAmountPaid,
      projectedRemainingAmount,
      projectedStatus,
      method,
      remark: remark || undefined,
    },
    previousPayload
      ? `待确认更新付款动作：${payable.id} 本次 ${amount.toFixed(2)} 元，执行后剩余 ${projectedRemainingAmount.toFixed(2)} 元。`
      : `待确认登记付款：${payable.id} 本次 ${amount.toFixed(2)} 元，执行后剩余 ${projectedRemainingAmount.toFixed(2)} 元。`,
    `将对供应商 ${payable.supplier} 的应付单 ${payable.id} 登记付款 ${amount.toFixed(2)} 元，方式为 ${method}；执行后累计已付 ${projectedAmountPaid.toFixed(2)} 元，剩余 ${projectedRemainingAmount.toFixed(2)} 元，状态预计为 ${projectedStatus}。${changeLines.length > 0 ? ` 本次调整：${changeLines.map((line) => line.replace('- 调整 ', '')).join('；')}` : ''}`,
    request.userId,
    request.username,
    previousPendingAction ? { supersedePendingActionId: previousPendingAction.id } : undefined,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：登记付款',
      ...(changeLines.length > 0 ? ['- 本次为更新已有待确认动作。', ...changeLines] : []),
      `- 应付单：${payable.id}`,
      `- 采购单：${payable.purchaseOrderId}`,
      `- 供应商：${payable.supplier}`,
      `- 应付总额：${payable.amountDue.toFixed(2)}`,
      `- 当前已付：${amountPaidBefore.toFixed(2)}`,
      `- 当前剩余：${payable.remainingAmount.toFixed(2)}`,
      `- 本次付款：${amount.toFixed(2)}`,
      `- 付款方式：${method}`,
      `- 执行后累计已付：${projectedAmountPaid.toFixed(2)}`,
      `- 执行后剩余：${projectedRemainingAmount.toFixed(2)}`,
      `- 执行后状态：${projectedStatus}`,
      `- 最近付款记录：${recentRecordsSummary}`,
      `- 备注：${remark || '-'}`,
      '- 执行影响：会新增付款记录、更新应付余额并可能改变应付状态。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实写入付款记录并更新应付状态。'),
  };
}

function buildCreateSalesOrderPlan(request: WriteActionPlanningRequest): WriteActionPlanningResult {
  const toolName: WriteToolName = 'create_sales_order';
  const requiredPermission = 'orders.create';

  if (!hasPermission(request.permissions, requiredPermission)) {
    return buildPermissionDeniedWriteResult(toolName, requiredPermission, '创建销售订单', '新增订单、订单明细与待发货单');
  }

  const previousPendingAction = getLatestPendingHistoryAction(request, toolName);
  const previousPayload = previousPendingAction ? (JSON.parse(previousPendingAction.payload) as PendingActionPayloadMap['create_sales_order']) : null;
  const parsed = parseCreateOrderPayload(request.prompt);
  const hasExplicitRemark = hasPromptField(request.prompt, ['备注']);
  const hasItemsInPrompt = Boolean(extractOrderItemsText(request.prompt));
  const payload: CreateOrderPayload = {
    customerName: parsed.payload.customerName || previousPayload?.customerName || '',
    orderChannel: parsed.payload.orderChannel || previousPayload?.orderChannel || '',
    expectedDeliveryDate: parsed.payload.expectedDeliveryDate || previousPayload?.expectedDeliveryDate || '',
    remark: hasExplicitRemark ? parsed.payload.remark : previousPayload?.remark,
    items: hasItemsInPrompt ? parsed.payload.items : previousPayload?.items || parsed.payload.items,
  };
  const missing: string[] = [];

  if (!payload.customerName) {
    missing.push('客户名称');
  }

  if (!payload.orderChannel) {
    missing.push('渠道');
  }

  if (!payload.expectedDeliveryDate) {
    missing.push('交付日期');
  }

  if (payload.items.length === 0) {
    missing.push('商品明细');
  }

  if (missing.length > 0) {
    return buildFollowUpIntentResult(
      toolName,
      `已识别创建订单意图，但缺少：${missing.join('、')}。`,
      missing.join('、'),
      [
        ['客户名称', payload.customerName],
        ['渠道', payload.orderChannel],
        ['交付日期', payload.expectedDeliveryDate],
        ['商品明细行数', payload.items.length],
      ],
      '创建订单 客户 朝阳社区店 渠道 门店补货 交付日期 2026-03-20 明细 SKU-1001*2, SKU-1002*1',
    );
  }

  if (hasItemsInPrompt && parsed.invalidTokens.length > 0) {
    return buildFollowUpIntentResult(
      toolName,
      `商品明细格式无法解析：${parsed.invalidTokens.join('、')}。`,
      '请按 “SKU-1001*2, SKU-1002*1” 的格式提供商品明细。',
      [
        ['客户名称', parsed.payload.customerName],
        ['渠道', parsed.payload.orderChannel],
        ['交付日期', parsed.payload.expectedDeliveryDate],
      ],
      '创建订单 客户 朝阳社区店 渠道 门店补货 交付日期 2026-03-20 明细 SKU-1001*2, SKU-1002*1',
    );
  }

  if (hasItemsInPrompt && parsed.missingSkus.length > 0) {
    return buildFollowUpIntentResult(
      toolName,
      `以下 SKU 不存在：${parsed.missingSkus.join('、')}。`,
      '请先确认 SKU 存在且为启用状态，再重新发起创建订单。',
      [
        ['客户名称', parsed.payload.customerName],
        ['渠道', parsed.payload.orderChannel],
        ['交付日期', parsed.payload.expectedDeliveryDate],
      ],
      '创建订单 客户 朝阳社区店 渠道 门店补货 交付日期 2026-03-20 明细 SKU-1001*2, SKU-1002*1',
    );
  }

  const totalQuantity = payload.items.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = payload.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const previousItemsSummary = previousPayload?.items.map((item) => `${item.sku}*${item.quantity}`).join(', ');
  const nextItemsSummary = payload.items.map((item) => `${item.sku}*${item.quantity}`).join(', ');
  const changeLines = previousPayload
    ? [
        buildDiffLine('客户', previousPayload.customerName, payload.customerName),
        buildDiffLine('渠道', previousPayload.orderChannel, payload.orderChannel),
        buildDiffLine('交付日期', previousPayload.expectedDeliveryDate, payload.expectedDeliveryDate),
        buildDiffLine('商品明细', previousItemsSummary, nextItemsSummary),
        buildDiffLine('备注', previousPayload.remark, payload.remark),
      ].filter(Boolean)
    : [];
  const pendingAction = createPendingAction(
    toolName,
    requiredPermission,
    payload,
    previousPayload
      ? `待确认更新订单创建动作：${payload.customerName} / ${payload.orderChannel} / ${payload.items.length} 行明细。`
      : `待确认创建订单：${payload.customerName} / ${payload.orderChannel} / ${payload.items.length} 行明细。`,
    `将为客户 ${payload.customerName} 创建销售订单，共 ${payload.items.length} 行明细，预计交付日期 ${payload.expectedDeliveryDate}。${changeLines.length > 0 ? ` 本次调整：${changeLines.map((line) => line.replace('- 调整 ', '')).join('；')}` : ''}`,
    request.userId,
    request.username,
    previousPendingAction ? { supersedePendingActionId: previousPendingAction.id } : undefined,
  );

  return {
    toolCalls: [{ name: toolName, status: 'awaiting_confirmation', summary: pendingAction.summary }],
    toolContext: [
      '待确认操作：创建销售订单',
      ...(changeLines.length > 0 ? ['- 本次为更新已有待确认动作。', ...changeLines] : []),
      `- 客户：${payload.customerName}`,
      `- 渠道：${payload.orderChannel}`,
      `- 交付日期：${payload.expectedDeliveryDate}`,
      `- 明细行数：${payload.items.length}`,
      `- 总数量：${totalQuantity}`,
      `- 预计金额：${totalAmount.toFixed(2)}`,
      ...payload.items.map((item) => `- ${item.sku} | ${item.productName} | 数量 ${item.quantity} | 单价 ${item.unitPrice.toFixed(2)}`),
      `- 备注：${payload.remark || '-'}`,
      '- 执行影响：会新增销售订单、写入订单明细，并生成待发货单和审计日志。',
      `- 确认提示：${pendingAction.confirmationMessage}`,
    ].join('\n'),
    pendingAction,
    replyHint: buildConfirmationReplyHint(pendingAction.summary, '确认后会真实创建订单和明细。'),
  };
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
    const receivableMutation = receiveReceivable(payload.receivableId, payload.amount, payload.method, payload.remark);
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
  } else if (row.actionName === 'import_documents_batch') {
    const payload = JSON.parse(row.payload) as ImportDocumentsBatchPayload;
    ensureAllRequiredPermissions(permissions, payload.requiredPermissions || []);
    const batchResult = executeImportDocumentsBatch(payload, trace);
    summary = batchResult.summary;
    reply = batchResult.reply;
    executionResult = batchResult.executionResult;
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









