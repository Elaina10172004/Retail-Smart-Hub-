export type ShippingStatus = '待发货' | '部分发货' | '已发货';
export type ShipmentStockStatus = '库存充足' | '待补货' | '-';

export interface ShippingRecord {
  id: string;
  orderId: string;
  orderIds: string[];
  orderCount: number;
  documentScope: '单订单' | '合并发货';
  customer: string;
  items: number;
  status: ShippingStatus;
  stockStatus: ShipmentStockStatus;
  courier: string;
  trackingNo: string;
  createdAt?: string;
}

export interface ShippingDetailRecord extends ShippingRecord {
  orderChannel: string;
  orderChannels: string[];
  shippedAt?: string;
  remark?: string;
  itemsDetail: Array<{
    orderId: string;
    sku: string;
    productName: string;
    quantity: number;
  }>;
}

export interface ShippingWorkbenchItem {
  orderItemId: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  shippedQty: number;
  reservedQty: number;
  remainingQty: number;
  suggestedShipQty: number;
}

export interface ShippingWorkbenchOrder {
  orderId: string;
  customer: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  status: ShippingStatus;
  stockStatus: ShipmentStockStatus;
  remainingQty: number;
  items: ShippingWorkbenchItem[];
}

export interface ShippingWorkbenchCustomer {
  customerName: string;
  totalOrders: number;
  totalPendingQty: number;
  orders: ShippingWorkbenchOrder[];
}

export interface CreateShipmentDocumentPayload {
  customerName: string;
  remark?: string;
  orders: Array<{
    orderId: string;
    items: Array<{
      orderItemId: string;
      quantity: number;
    }>;
  }>;
}
