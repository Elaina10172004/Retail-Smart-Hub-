export type OrderStatus = '待发货' | '已发货' | '已完成' | '已取消';
export type StockStatus = '库存充足' | '部分缺货' | '待校验' | '-';

export interface OrderRecord {
  id: string;
  customer: string;
  date: string;
  amount: string;
  status: OrderStatus;
  stockStatus: StockStatus;
  itemCount: number;
  expectedDeliveryDate?: string;
  remark?: string;
}

export interface OrderItemDraft {
  id: string;
  sku: string;
  productName: string;
  quantity: string;
  unitPrice: string;
}

export interface OrderItemPayload {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateOrderPayload {
  customerName: string;
  orderChannel: string;
  expectedDeliveryDate: string;
  remark?: string;
  items: OrderItemPayload[];
}

export interface UpdateOrderStatusPayload {
  status: '已完成' | '已取消';
}

export interface DeleteOrderResponse {
  id: string;
  deleted: boolean;
}

export interface OrderDetailItem {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineAmount: number;
}

export interface OrderDetailRecord {
  id: string;
  customerName: string;
  orderChannel: string;
  orderDate: string;
  createdAt: string;
  expectedDeliveryDate: string;
  status: OrderStatus;
  stockStatus: StockStatus;
  totalAmount: number;
  itemCount: number;
  remark?: string;
  items: OrderDetailItem[];
  shipping?: {
    deliveryId: string;
    shipmentStatus: string;
    courier?: string;
    trackingNo?: string;
    shippedAt?: string;
  };
  receivable?: {
    receivableId: string;
    amountDue: number;
    amountPaid: number;
    remainingAmount: number;
    dueDate: string;
  };
}
