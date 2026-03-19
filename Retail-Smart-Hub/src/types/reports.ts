export interface ReportSummary {
  totalSales: number;
  totalProfit: number;
  shippedOrders: number;
  lowStockCount: number;
  pendingReceivable: number;
  inventoryValue: number;
}

export interface SalesTrendPoint {
  name: string;
  sales: number;
  profit: number;
}

export interface CategoryDistributionPoint {
  name: string;
  value: number;
}

export interface InventoryTurnoverPoint {
  name: string;
  turnover: number;
}

export interface AgingPoint {
  bucket: string;
  receivable: number;
  payable: number;
  net: number;
}

export interface ReportOverview {
  summary: ReportSummary;
  salesTrend: SalesTrendPoint[];
  categoryDistribution: CategoryDistributionPoint[];
  inventoryTurnover: InventoryTurnoverPoint[];
  agingAnalysis: AgingPoint[];
}
