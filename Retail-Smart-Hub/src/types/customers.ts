export type CustomerStatus = 'active' | 'inactive';
export type CustomerType = 'reseller' | 'supplier';

export interface CustomerSummary {
  customerCount: number;
  activeCustomerCount: number;
  resellerCount: number;
  supplierCount: number;
  totalSales: number;
  thisMonthActiveCount: number;
}

export interface CustomerRecord {
  id: string;
  name: string;
  customerType: CustomerType;
  channelPreference: string;
  contactName: string;
  phone: string;
  level: string;
  totalOrders: number;
  totalSales: number;
  lastOrderDate: string;
  status: CustomerStatus;
}

export interface CreateCustomerPayload {
  name: string;
  customerType: CustomerType;
  channelPreference: string;
  contactName?: string;
  phone?: string;
}

export interface UpdateCustomerPayload extends CreateCustomerPayload {}

export interface CustomerDetailRecord extends CustomerRecord {}
