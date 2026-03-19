export interface ProcurementOrder {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: string;
  source: string;
}

export interface ProcurementOrderDetail extends ProcurementOrder {
  remark?: string;
  itemCount: number;
  items: Array<{
    id: string;
    sku: string;
    productName: string;
    orderedQty: number;
    arrivedQty: number;
    unitCost: number;
    lineAmount: number;
  }>;
}

export interface ProcurementSuggestionSummary {
  lowStockItemCount: number;
  recommendedOrderCount: number;
  recommendedSkus: string[];
  message: string;
}

export interface GeneratedPurchaseOrder {
  id: string;
  supplier: string;
  amount: string;
  itemCount: number;
  status: string;
}

export interface UpdateProcurementStatusPayload {
  status: string;
}

export interface DeleteProcurementOrderResponse {
  id: string;
  deleted: boolean;
}
