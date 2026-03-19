export type ShippingStatus = '待发货' | '已发货';
export type ShipmentStockStatus = '库存充足' | '待补货' | '-';

export interface ShippingRecord {
  id: string;
  orderId: string;
  customer: string;
  items: number;
  status: ShippingStatus;
  stockStatus: ShipmentStockStatus;
  courier: string;
  trackingNo: string;
}

export interface ShippingDetailRecord extends ShippingRecord {
  orderChannel: string;
  createdAt: string;
  shippedAt?: string;
  remark?: string;
  itemsDetail: Array<{
    sku: string;
    productName: string;
    quantity: number;
  }>;
}
