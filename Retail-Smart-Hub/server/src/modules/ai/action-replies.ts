import type { ArrivalRecord } from '../arrival/arrival.service';
import type { PaymentRecord, PayableDetailRecord, ReceiptRecord, ReceivableDetailRecord } from '../finance/finance.service';
import type { InboundRecord } from '../inbound/inbound.service';
import type { CreateOrderPayload, OrderRecord } from '../orders/orders.service';
import type { ShippingRecord } from '../shipping/shipping.service';

export function summarizeReceiptRecords(records: ReceiptRecord[]) {
  if (records.length === 0) {
    return '无历史收款记录';
  }

  return records
    .slice(0, 2)
    .map((item) => `${item.id} ${item.receivedAt} ${item.amount.toFixed(2)} 元 ${item.method}`)
    .join('；');
}

export function summarizePaymentRecords(records: PaymentRecord[]) {
  if (records.length === 0) {
    return '无历史付款记录';
  }

  return records
    .slice(0, 2)
    .map((item) => `${item.id} ${item.paidAt} ${item.amount.toFixed(2)} 元 ${item.method}`)
    .join('；');
}

export function buildArrivalReply(record: ArrivalRecord) {
  return [
    `已确认并执行：到货单 ${record.id} 已推进。`,
    `- 采购单：${record.poId}`,
    `- 供应商：${record.supplier}`,
    `- 状态：${record.status}`,
    `- 合格数量：${record.qualifiedQty}`,
  ].join('\n');
}

export function buildInboundReply(record: InboundRecord) {
  return [
    `已确认并执行：入库单 ${record.id} 已完成入库。`,
    `- 到货单：${record.rcvId}`,
    `- 供应商：${record.supplier}`,
    `- 入库数量：${record.items}`,
    `- 状态：${record.status}`,
  ].join('\n');
}

export function buildShippingReply(record: ShippingRecord) {
  return [
    `已确认并执行：发货单 ${record.id} 已发货。`,
    `- 订单号：${record.orderId}`,
    `- 客户：${record.customer}`,
    `- 物流：${record.courier}`,
    `- 运单号：${record.trackingNo}`,
    `- 状态：${record.status}`,
  ].join('\n');
}

export function buildReceiptReply(record: ReceivableDetailRecord, amount: number, method: string) {
  const latestRecord = record.records[0];
  return [
    `已确认并执行：应收单 ${record.id} 已登记收款。`,
    `- 订单号：${record.orderId}`,
    `- 客户：${record.customer}`,
    `- 本次收款：${amount.toFixed(2)}`,
    `- 收款方式：${method}`,
    `- 本次收款记录：${latestRecord ? `${latestRecord.id} / ${latestRecord.receivedAt}` : '-'}`,
    `- 历史收款记录数：${record.records.length}`,
    `- 累计已收：${record.amountPaid.toFixed(2)}`,
    `- 剩余应收：${record.remainingAmount.toFixed(2)}`,
    `- 状态：${record.status}`,
    `- 最近记录：${summarizeReceiptRecords(record.records)}`,
  ].join('\n');
}

export function buildPaymentReply(record: PayableDetailRecord, amount: number, method: string) {
  const latestRecord = record.records[0];
  return [
    `已确认并执行：应付单 ${record.id} 已登记付款。`,
    `- 采购单：${record.purchaseOrderId}`,
    `- 供应商：${record.supplier}`,
    `- 本次付款：${amount.toFixed(2)}`,
    `- 付款方式：${method}`,
    `- 本次付款记录：${latestRecord ? `${latestRecord.id} / ${latestRecord.paidAt}` : '-'}`,
    `- 历史付款记录数：${record.records.length}`,
    `- 累计已付：${record.amountPaid.toFixed(2)}`,
    `- 剩余应付：${record.remainingAmount.toFixed(2)}`,
    `- 状态：${record.status}`,
    `- 最近记录：${summarizePaymentRecords(record.records)}`,
  ].join('\n');
}

export function buildOrderReply(record: OrderRecord, payload: CreateOrderPayload) {
  return [
    `已确认并执行：订单 ${record.id} 创建完成。`,
    `- 客户：${payload.customerName}`,
    `- 渠道：${payload.orderChannel}`,
    `- 交付日期：${payload.expectedDeliveryDate}`,
    `- 金额：${record.amount}`,
    `- 库存状态：${record.stockStatus}`,
    `- 状态：${record.status}`,
  ].join('\n');
}
