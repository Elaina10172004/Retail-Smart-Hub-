export interface InboundRecord {
  id: string;
  rcvId: string;
  supplier: string;
  items: number;
  warehouse: string;
  status: string;
}

export interface InboundShelfOption {
  id: string;
  shelfCode: string;
  shelfName: string;
  tags: string[];
  capacity: number;
  usedQuantity: number;
  remainingCapacity: number;
}

export interface InboundDetailItem {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  arrivedQty: number;
  qualifiedQty: number;
  defectQty: number;
  inboundQty: number;
  shelfId?: string;
  shelfCode?: string;
  shelfName?: string;
  suggestedShelfId?: string;
  suggestedShelfCode?: string;
}

export interface InboundDetailRecord extends InboundRecord {
  poId: string;
  warehouseId: string;
  completedAt?: string;
  shelfOptions: InboundShelfOption[];
  itemsDetail: InboundDetailItem[];
}

export interface UpdateInboundStatusPayload {
  status: '待入库' | '已入库';
}

export interface SaveInboundDraftItemPayload {
  itemId: string;
  qualifiedQty: number;
  inboundQty: number;
  shelfId: string;
}

export interface SaveInboundDraftPayload {
  items: SaveInboundDraftItemPayload[];
}

export interface DeleteInboundResponse {
  id: string;
  deleted: boolean;
}
