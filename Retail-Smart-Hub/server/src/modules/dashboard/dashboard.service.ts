import { db } from '../../database/db';
import { addDays, currentDateString } from '../../shared/format';
import { getFinanceOverview } from '../finance/finance.service';
import { getInventoryAlerts } from '../inventory/inventory.service';
import { getProcurementSuggestions, listProcurementOrders } from '../procurement/procurement.service';
import { listShipments } from '../shipping/shipping.service';

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

function getRecentSalesTrend() {
  const today = currentDateString();
  const rows = db.prepare<{ orderDate: string; sales: number }>(`
    SELECT
      order_date as orderDate,
      COALESCE(SUM(total_amount), 0) as sales
    FROM sales_orders
    WHERE order_date BETWEEN ? AND ?
      AND status <> '已取消'
    GROUP BY order_date
    ORDER BY order_date ASC
  `).all(addDays(today, -6), today);

  const map = new Map(rows.map((row) => [row.orderDate, row.sales]));

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index - 6);
    return {
      name: date.slice(5),
      sales: map.get(date) ?? 0,
    };
  });
}

export function getDashboardOverview(): DashboardOverview {
  const today = currentDateString();
  const currentMonth = today.slice(0, 7);
  const financeOverview = getFinanceOverview();
  const procurementSuggestion = getProcurementSuggestions();

  const todayOrderCount =
    db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM sales_orders WHERE order_date = ?').get(today)?.count ?? 0;
  const inventoryUnits =
    db.prepare<{ total: number }>('SELECT COALESCE(SUM(current_stock), 0) as total FROM inventory').get()?.total ?? 0;
  const monthlySales =
    db.prepare<{ total: number }>(
      `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_orders WHERE substr(order_date, 1, 7) = ? AND status <> '已取消'`
    ).get(currentMonth)?.total ?? 0;

  const alerts = getInventoryAlerts().slice(0, 3).map((item) => ({
    id: item.sku,
    name: item.name,
    stock: item.currentStock,
    safeStock: item.safeStock,
    status: item.status,
  }));

  const pendingProcurements = listProcurementOrders()
    .filter((item) => item.status !== '已完成')
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      supplier: item.supplier,
      amount: item.amount,
      date: item.createDate,
    }));

  const pendingShipments = listShipments()
    .filter((item) => item.status === '待发货')
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      customer: item.customer,
      items: item.items,
      status: item.stockStatus,
    }));

  return {
    stats: {
      todayOrderCount,
      inventoryUnits,
      lowStockCount: alerts.length,
      monthlySales,
      pendingShipmentCount: pendingShipments.length,
      pendingProcurementCount: pendingProcurements.length,
      pendingReceivable: financeOverview.totalReceivable,
    },
    salesTrend: getRecentSalesTrend(),
    inventoryAlerts: alerts,
    pendingProcurements,
    pendingShipments,
    aiSuggestion: {
      message: procurementSuggestion.message,
      recommendedSkus: procurementSuggestion.recommendedSkus.slice(0, 3),
    },
  };
}
