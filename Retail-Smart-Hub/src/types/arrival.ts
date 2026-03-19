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
