import { formatCurrency } from '@/lib/format';
import type { DocumentPreviewRecord } from '@/types/documents';
import type { InboundDetailRecord } from '@/types/inbound';
import type { OrderDetailRecord } from '@/types/orders';
import type { ProcurementOrderDetail } from '@/types/procurement';
import type { ShippingDetailRecord } from '@/types/shipping';

const DEFAULT_DOCUMENT_FOOTER = 'Retail Smart Hub · 系统单据预览';

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }

  const normalized = value.includes('T') ? value : `${value}T00:00:00`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  if (value.includes('T')) {
    return parsed.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  return parsed.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function buildProcurementDocument(detail: ProcurementOrderDetail): DocumentPreviewRecord {
  return {
    id: detail.id,
    type: 'procurement',
    title: '采购单',
    documentNo: detail.id,
    status: detail.status,
    headerFields: [
      { label: '创建日期', value: formatDateTime(detail.createDate) },
      { label: '预计到货', value: formatDateTime(detail.expectedDate) },
      { label: '单据状态', value: detail.status, emphasize: true },
      { label: '来源', value: detail.source },
    ],
    partyFields: [{ label: '供应商', value: detail.supplier, emphasize: true }],
    columns: [
      { key: 'sku', label: 'SKU', width: '17%' },
      { key: 'productName', label: '商品名称', width: '29%' },
      { key: 'orderedQty', label: '订购数量', align: 'right', width: '12%' },
      { key: 'arrivedQty', label: '到货数量', align: 'right', width: '12%' },
      { key: 'unitCost', label: '采购单价', align: 'right', width: '15%' },
      { key: 'lineAmount', label: '行金额', align: 'right', width: '15%' },
    ],
    rows: detail.items.map((item) => ({
      id: item.id,
      values: {
        sku: item.sku,
        productName: item.productName,
        orderedQty: formatQuantity(item.orderedQty),
        arrivedQty: formatQuantity(item.arrivedQty),
        unitCost: formatCurrency(item.unitCost),
        lineAmount: formatCurrency(item.lineAmount),
      },
    })),
    summaryFields: [
      { label: '采购总金额', value: detail.amount, emphasize: true },
      { label: '商品总件数', value: `${detail.itemCount} 件` },
    ],
    remark: detail.remark,
    footerNote: DEFAULT_DOCUMENT_FOOTER,
  };
}

export function buildOrderDocument(detail: OrderDetailRecord): DocumentPreviewRecord {
  return {
    id: detail.id,
    type: 'order',
    title: '销售订单',
    documentNo: detail.id,
    status: detail.status,
    headerFields: [
      { label: '下单日期', value: formatDateTime(detail.orderDate) },
      { label: '创建时间', value: formatDateTime(detail.createdAt) },
      { label: '期望交付', value: formatDateTime(detail.expectedDeliveryDate) },
      { label: '库存状态', value: detail.stockStatus },
    ],
    partyFields: [
      { label: '客户 / 门店', value: detail.customerName, emphasize: true },
      { label: '订单渠道', value: detail.orderChannel },
    ],
    referenceFields: [
      { label: '发货单号', value: detail.shipping?.deliveryId || '-' },
      { label: '应收单号', value: detail.receivable?.receivableId || '-' },
    ],
    columns: [
      { key: 'sku', label: 'SKU', width: '18%' },
      { key: 'productName', label: '商品名称', width: '34%' },
      { key: 'quantity', label: '数量', align: 'right', width: '12%' },
      { key: 'unitPrice', label: '销售单价', align: 'right', width: '18%' },
      { key: 'lineAmount', label: '行金额', align: 'right', width: '18%' },
    ],
    rows: detail.items.map((item) => ({
      id: item.id,
      values: {
        sku: item.sku,
        productName: item.productName,
        quantity: formatQuantity(item.quantity),
        unitPrice: formatCurrency(item.unitPrice),
        lineAmount: formatCurrency(item.lineAmount),
      },
    })),
    summaryFields: [
      { label: '订单总金额', value: formatCurrency(detail.totalAmount), emphasize: true },
      { label: '商品总件数', value: `${detail.itemCount} 件` },
    ],
    remark: detail.remark,
    footerNote: DEFAULT_DOCUMENT_FOOTER,
  };
}

export function buildInboundDocument(detail: InboundDetailRecord): DocumentPreviewRecord {
  const totalQuantity = detail.itemsDetail.reduce((sum, item) => sum + item.qualifiedQty, 0);

  return {
    id: detail.id,
    type: 'inbound',
    title: '入库单',
    documentNo: detail.id,
    status: detail.status,
    headerFields: [
      { label: '入库状态', value: detail.status, emphasize: true },
      { label: '完成时间', value: formatDateTime(detail.completedAt) },
    ],
    partyFields: [
      { label: '供应商', value: detail.supplier, emphasize: true },
      { label: '仓库 / 库位', value: detail.warehouse },
    ],
    referenceFields: [
      { label: '收货单号', value: detail.rcvId },
      { label: '采购单号', value: detail.poId },
    ],
    columns: [
      { key: 'sku', label: 'SKU', width: '25%' },
      { key: 'productName', label: '商品名称', width: '55%' },
      { key: 'qualifiedQty', label: '入库数量', align: 'right', width: '20%' },
    ],
    rows: detail.itemsDetail.map((item) => ({
      id: `${detail.id}-${item.sku}`,
      values: {
        sku: item.sku,
        productName: item.productName,
        qualifiedQty: formatQuantity(item.qualifiedQty),
      },
    })),
    summaryFields: [{ label: '入库总数量', value: `${totalQuantity} 件`, emphasize: true }],
    footerNote: DEFAULT_DOCUMENT_FOOTER,
  };
}

export function buildShippingDocument(detail: ShippingDetailRecord): DocumentPreviewRecord {
  const totalQuantity = detail.itemsDetail.reduce((sum, item) => sum + item.quantity, 0);

  return {
    id: detail.id,
    type: 'shipping',
    title: '发货出库单',
    documentNo: detail.id,
    status: detail.status,
    headerFields: [
      { label: '创建时间', value: formatDateTime(detail.createdAt) },
      { label: '发货时间', value: formatDateTime(detail.shippedAt) },
      { label: '发货状态', value: detail.status, emphasize: true },
      { label: '库存状态', value: detail.stockStatus },
    ],
    partyFields: [
      { label: '客户 / 门店', value: detail.customer, emphasize: true },
      { label: '订单渠道', value: detail.orderChannel },
    ],
    referenceFields: [
      { label: '关联订单', value: detail.orderId },
      { label: '物流公司', value: detail.courier || '-' },
      { label: '运单号', value: detail.trackingNo || '-' },
    ],
    columns: [
      { key: 'sku', label: 'SKU', width: '25%' },
      { key: 'productName', label: '商品名称', width: '55%' },
      { key: 'quantity', label: '出库数量', align: 'right', width: '20%' },
    ],
    rows: detail.itemsDetail.map((item) => ({
      id: `${detail.id}-${item.sku}`,
      values: {
        sku: item.sku,
        productName: item.productName,
        quantity: formatQuantity(item.quantity),
      },
    })),
    summaryFields: [{ label: '出库总数量', value: `${totalQuantity} 件`, emphasize: true }],
    remark: detail.remark,
    footerNote: DEFAULT_DOCUMENT_FOOTER,
  };
}
