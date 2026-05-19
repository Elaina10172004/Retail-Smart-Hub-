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

export interface ProcurementFormSupplierOption {
  id: string;
  name: string;
  leadTimeDays: number;
}

export interface ProcurementFormProductOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  costPrice: number;
  preferredSupplierId: string;
  preferredSupplier: string;
}

export interface ProcurementFormOptions {
  suppliers: ProcurementFormSupplierOption[];
  products: ProcurementFormProductOption[];
}

export interface CreateProcurementNewProductPayload {
  name: string;
  sku?: string;
  salePrice?: number;
  category?: string;
  unit?: string;
  safeStock?: number;
}

export interface CreateProcurementOrderExistingItemPayload {
  mode: 'existing';
  supplierId?: string;
  productId: string;
  quantity: number;
  unitCost: number;
}

export interface CreateProcurementOrderNewItemPayload {
  mode: 'new';
  supplierId?: string;
  quantity: number;
  unitCost: number;
  newProduct: CreateProcurementNewProductPayload;
}

export type CreateProcurementOrderItemPayload =
  | CreateProcurementOrderExistingItemPayload
  | CreateProcurementOrderNewItemPayload;

export interface CreateProcurementOrderPayload {
  supplierId: string;
  expectedDate: string;
  remark?: string;
  items: CreateProcurementOrderItemPayload[];
}

export interface UpdateProcurementStatusPayload {
  status: string;
}

export interface ForceUpdateProcurementLineItemPayload {
  itemId: string;
  orderedQty: number;
  unitCost: number;
}

export interface ForceUpdateProcurementLinesPayload {
  reason?: string;
  items: ForceUpdateProcurementLineItemPayload[];
}

export interface DeleteProcurementOrderResponse {
  id: string;
  deleted: boolean;
}

export interface ProcurementArrivalWorkspaceItem {
  itemId: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
  remainingQty: number;
}

export interface ProcurementArrivalWorkspaceRecord {
  purchaseOrderId: string;
  arrivalId?: string;
  supplier: string;
  expectedDate: string;
  procurementStatus: string;
  arrivalStatus?: string;
  arrivedAt?: string;
  editable: boolean;
  items: ProcurementArrivalWorkspaceItem[];
  totalOrderedQty: number;
  totalArrivedQty: number;
  totalRemainingQty: number;
}

export interface RegisterProcurementArrivalItemPayload {
  itemId: string;
  arrivedQty: number;
}

export interface RegisterProcurementArrivalPayload {
  items: RegisterProcurementArrivalItemPayload[];
}
