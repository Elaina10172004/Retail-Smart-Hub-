export interface DashboardStatSummary {
  todayOrderCount: number;
  inventoryUnits: number;
  lowStockCount: number;
  monthlySales: number;
  pendingShipmentCount: number;
  pendingProcurementCount: number;
  pendingReceivable: number;
}

export interface DashboardSalesPoint {
  name: string;
  sales: number;
}

export interface DashboardAlertItem {
  id: string;
  name: string;
  stock: number;
  safeStock: number;
  status: string;
}

export interface DashboardProcurementItem {
  id: string;
  supplier: string;
  amount: string;
  date: string;
}

export interface DashboardShipmentItem {
  id: string;
  customer: string;
  items: number;
  status: string;
}

export interface DashboardOverview {
  stats: DashboardStatSummary;
  salesTrend: DashboardSalesPoint[];
  inventoryAlerts: DashboardAlertItem[];
  pendingProcurements: DashboardProcurementItem[];
  pendingShipments: DashboardShipmentItem[];
  aiSuggestion: {
    message: string;
    recommendedSkus: string[];
  };
}
