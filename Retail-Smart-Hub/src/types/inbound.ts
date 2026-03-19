export interface InboundRecord {
  id: string;
  rcvId: string;
  supplier: string;
  items: number;
  warehouse: string;
  status: string;
}

export interface InboundDetailRecord extends InboundRecord {
  poId: string;
  completedAt?: string;
  itemsDetail: Array<{
    sku: string;
    productName: string;
    qualifiedQty: number;
  }>;
}

export interface UpdateInboundStatusPayload {
  status: '待入库' | '已入库';
}

export interface DeleteInboundResponse {
  id: string;
  deleted: boolean;
}
