export type CustomerStatus = 'active' | 'inactive';

export interface CustomerSummary {
  customerCount: number;
  activeCustomerCount: number;
  totalSales: number;
  thisMonthActiveCount: number;
}

export interface CustomerRecord {
  id: string;
  name: string;
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
  channelPreference: string;
  contactName?: string;
  phone?: string;
}

export interface UpdateCustomerPayload extends CreateCustomerPayload {}

export interface CustomerDetailRecord extends CustomerRecord {}
