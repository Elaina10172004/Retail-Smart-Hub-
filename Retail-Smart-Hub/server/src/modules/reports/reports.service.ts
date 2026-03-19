import { db } from '../../database/db';
import { currentDateString } from '../../shared/format';
import { getFinanceOverview, listPayables, listReceivables } from '../finance/finance.service';

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

interface MonthlySalesRow {
  month: string;
  sales: number;
  profit: number;
}

interface CategoryRow {
  category: string;
  value: number;
}

interface TurnoverRow {
  name: string;
  soldQty: number;
  currentStock: number;
}

function currentYear() {
  return currentDateString().slice(0, 4);
}

function buildMonthLabel(month: number) {
  return `${month}月`;
}

function ageBucket(daysOverdue: number) {
  if (daysOverdue > 90) {
    return '90天以上';
  }

  if (daysOverdue > 60) {
    return '61-90天';
  }

  if (daysOverdue > 30) {
    return '31-60天';
  }

  return '30天以内';
}

function getSummary(): ReportSummary {
  const financeOverview = getFinanceOverview();
  const totalSales =
    db.prepare<{ total: number }>(
      `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_orders WHERE status <> '已取消'`
    ).get()?.total ?? 0;

  const totalProfit =
    db.prepare<{ total: number }>(`
      SELECT COALESCE(SUM((soi.quantity * soi.unit_price) - (soi.quantity * p.cost_price)), 0) as total
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      LEFT JOIN products p ON p.id = soi.product_id
      WHERE so.status <> '已取消'
    `).get()?.total ?? 0;

  const shippedOrders =
    db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM sales_orders WHERE status IN ('已发货', '已完成')`
    ).get()?.count ?? 0;

  const lowStockCount =
    db.prepare<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id
        GROUP BY p.id, p.safe_stock
        HAVING COALESCE(SUM(i.current_stock), 0) < p.safe_stock
      )
    `).get()?.count ?? 0;

  const inventoryValue =
    db.prepare<{ total: number }>(`
      SELECT COALESCE(SUM(i.current_stock * p.cost_price), 0) as total
      FROM inventory i
      JOIN products p ON p.id = i.product_id
    `).get()?.total ?? 0;

  return {
    totalSales,
    totalProfit,
    shippedOrders,
    lowStockCount,
    pendingReceivable: financeOverview.totalReceivable,
    inventoryValue,
  };
}

function getSalesTrend(): SalesTrendPoint[] {
  const rows = db.prepare<MonthlySalesRow>(`
    SELECT
      substr(so.order_date, 6, 2) as month,
      COALESCE(SUM(so.total_amount), 0) as sales,
      COALESCE(SUM(lineProfit.profit), 0) as profit
    FROM sales_orders so
    LEFT JOIN (
      SELECT
        soi.sales_order_id,
        SUM((soi.quantity * soi.unit_price) - (soi.quantity * p.cost_price)) as profit
      FROM sales_order_items soi
      LEFT JOIN products p ON p.id = soi.product_id
      GROUP BY soi.sales_order_id
    ) lineProfit ON lineProfit.sales_order_id = so.id
    WHERE substr(so.order_date, 1, 4) = ?
      AND so.status <> '已取消'
    GROUP BY substr(so.order_date, 6, 2)
    ORDER BY month ASC
  `).all(currentYear());

  const monthMap = new Map(rows.map((row) => [Number(row.month), row]));

  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const row = monthMap.get(month);
    return {
      name: buildMonthLabel(month),
      sales: row?.sales ?? 0,
      profit: row?.profit ?? 0,
    };
  });
}

function getCategoryDistribution() {
  return db.prepare<CategoryRow>(`
    SELECT
      p.category,
      COALESCE(SUM(soi.quantity * soi.unit_price), 0) as value
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    LEFT JOIN products p ON p.id = soi.product_id
    WHERE so.status <> '已取消'
    GROUP BY p.category
    ORDER BY value DESC, p.category ASC
  `).all().map((row) => ({
    name: row.category || '未分类',
    value: row.value,
  }));
}

function getInventoryTurnover() {
  const rows = db.prepare<TurnoverRow>(`
    SELECT
      p.name,
      COALESCE(sales.soldQty, 0) as soldQty,
      COALESCE(stock.currentStock, 0) as currentStock
    FROM products p
    LEFT JOIN (
      SELECT
        soi.product_id,
        SUM(soi.quantity) as soldQty
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      WHERE so.status <> '已取消'
      GROUP BY soi.product_id
    ) sales ON sales.product_id = p.id
    LEFT JOIN (
      SELECT
        product_id,
        SUM(current_stock) as currentStock
      FROM inventory
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    ORDER BY COALESCE(sales.soldQty, 0) DESC, p.name ASC
    LIMIT 5
  `).all();

  return rows.map((row) => {
    const averageStock = Math.max((row.soldQty + row.currentStock) / 2, 1);
    return {
      name: row.name,
      turnover: Number((row.soldQty / averageStock).toFixed(2)),
    };
  });
}

function getAgingAnalysis(): AgingPoint[] {
  const buckets = ['30天以内', '31-60天', '61-90天', '90天以上'];
  const receivableMap = new Map<string, number>(buckets.map((bucket) => [bucket, 0]));
  const payableMap = new Map<string, number>(buckets.map((bucket) => [bucket, 0]));

  listReceivables()
    .filter((item) => item.remainingAmount > 0)
    .forEach((item) => {
      const bucket = ageBucket(item.daysOverdue);
      receivableMap.set(bucket, (receivableMap.get(bucket) ?? 0) + item.remainingAmount);
    });

  listPayables()
    .filter((item) => item.remainingAmount > 0)
    .forEach((item) => {
      const bucket = ageBucket(item.daysOverdue);
      payableMap.set(bucket, (payableMap.get(bucket) ?? 0) + item.remainingAmount);
    });

  return buckets.map((bucket) => {
    const receivable = receivableMap.get(bucket) ?? 0;
    const payable = payableMap.get(bucket) ?? 0;
    return {
      bucket,
      receivable,
      payable,
      net: receivable - payable,
    };
  });
}

export function getReportOverview(): ReportOverview {
  return {
    summary: getSummary(),
    salesTrend: getSalesTrend(),
    categoryDistribution: getCategoryDistribution(),
    inventoryTurnover: getInventoryTurnover(),
    agingAnalysis: getAgingAnalysis(),
  };
}
