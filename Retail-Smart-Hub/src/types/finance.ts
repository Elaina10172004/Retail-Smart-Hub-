export type ReceivableStatus = '未收款' | '部分收款' | '已收款' | '逾期';
export type PayableStatus = '未付款' | '部分付款' | '已付款' | '逾期';

export interface FinanceOverview {
  totalReceivable: number;
  overdueReceivable: number;
  totalPayable: number;
  dueThisWeekPayable: number;
  monthlyReceived: number;
  monthlyPaid: number;
  pendingReceivableCount: number;
  pendingPayableCount: number;
}

export interface ReceiptRecord {
  id: string;
  receivableId: string;
  amount: number;
  receivedAt: string;
  method: string;
  remark?: string;
}

export interface PaymentRecord {
  id: string;
  payableId: string;
  amount: number;
  paidAt: string;
  method: string;
  remark?: string;
}

export interface ReceivableRecord {
  id: string;
  orderId: string;
  customer: string;
  amountDue: number;
  amountPaid: number;
  remainingAmount: number;
  dueDate: string;
  lastReceivedAt?: string;
  status: ReceivableStatus;
  daysOverdue: number;
}

export interface ReceivableDetailRecord extends ReceivableRecord {
  customerName: string;
  orderChannel: string;
  remark?: string;
  records: ReceiptRecord[];
}

export interface PayableRecord {
  id: string;
  purchaseOrderId: string;
  supplier: string;
  amountDue: number;
  amountPaid: number;
  remainingAmount: number;
  dueDate: string;
  lastPaidAt?: string;
  status: PayableStatus;
  daysOverdue: number;
}

export interface PayableDetailRecord extends PayableRecord {
  remark?: string;
  records: PaymentRecord[];
}

export interface FinanceActionPayload {
  amount: number;
  method?: string;
  remark?: string;
}
