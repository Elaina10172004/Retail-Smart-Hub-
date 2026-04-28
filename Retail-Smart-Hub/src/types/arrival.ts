export interface ArrivalRecord {
  id: string;
  poId: string;
  supplier: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
  status: string;
}

export interface ArrivalDetailRecord extends ArrivalRecord {
  arrivedAt: string;
  sourcePurchaseOrderIds?: string[];
  items: Array<{
    id: string;
    sku: string;
    productName: string;
    expectedQty: number;
    arrivedQty: number;
    qualifiedQty: number;
    defectQty: number;
  }>;
}

export interface ManualArrivalCandidateItem {
  supplierId: string;
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  supplier: string;
  expectedDate: string;
  procurementStatus: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
  remainingQty: number;
  unitCost: number;
}

export interface CreateManualArrivalItemPayload {
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  arrivedQty: number;
}

export interface CreateManualArrivalPayload {
  items: CreateManualArrivalItemPayload[];
}

export interface CreateManualArrivalResult {
  arrivalIds: string[];
}
