export type InventoryStatus = '正常' | '预警' | '缺货';

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  currentStock: number;
  safeStock: number;
  transitStock: number;
  status: InventoryStatus;
  shelfSummary: string;
}

export interface InventoryAlert {
  sku: string;
  name: string;
  currentStock: number;
  safeStock: number;
  transitStock: number;
  gap: number;
  status: InventoryStatus;
}

export interface InventoryOverview {
  totalInventoryValue: number;
  capacityUsageRate: number;
  shortageCount: number;
  warningCount: number;
  totalSkus: number;
  totalShelfCount: number;
  availableShelfCount: number;
}

export interface InventoryWarehouseStock {
  warehouseId: string;
  warehouseName: string;
  locationCode: string;
  currentStock: number;
  reservedStock: number;
}

export interface InventoryShelfPlacement {
  shelfId: string;
  warehouseId: string;
  warehouseName: string;
  shelfCode: string;
  shelfName: string;
  tags: string[];
  quantity: number;
  capacity: number;
  remainingCapacity: number;
}

export interface InventoryShelfOverviewRecord {
  shelfId: string;
  warehouseId: string;
  warehouseName: string;
  shelfCode: string;
  shelfName: string;
  tags: string[];
  capacity: number;
  usedQuantity: number;
  remainingCapacity: number;
  itemCount: number;
  status: '空闲' | '可用' | '紧张' | '满位';
}

export interface InventoryMovementRecord {
  id: string;
  type: '入库' | '出库' | '盘点';
  referenceId: string;
  quantity: number;
  occurredAt: string;
  summary: string;
}

export interface InventoryDetailRecord extends InventoryItem {
  unit: string;
  salePrice: number;
  costPrice: number;
  preferredSupplier: string;
  leadTimeDays: number;
  warehouses: InventoryWarehouseStock[];
  shelfPlacements: InventoryShelfPlacement[];
  recentMovements: InventoryMovementRecord[];
}

export interface InventoryAdjustmentPayload {
  sku: string;
  targetStock: number;
  reason?: string;
}

export interface DeleteInventoryResponse {
  sku: string;
  deleted: boolean;
}
