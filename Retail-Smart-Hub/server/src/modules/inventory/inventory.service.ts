import { appendAuditLog, appendInventoryMovement, db } from '../../database/db';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';
import { getProductShelfPlacements, getShelfUsageRate, listWarehouseShelves, rebalanceShelfStock } from './inventory-shelf.service';
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

interface InventoryRow {
  productId: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  safeStock: number;
  currentStock: number;
  transitStock: number;
  salePrice: number;
  costPrice: number;
  supplierName: string | null;
  leadTimeDays: number | null;
}

function buildStatus(currentStock: number, safeStock: number): InventoryStatus {
  if (currentStock < safeStock * 0.6) {
    return '缺货';
  }

  if (currentStock < safeStock) {
    return '预警';
  }

  return '正常';
}

function baseInventoryRows() {
  return db.prepare<InventoryRow>(`
    SELECT
      p.id as productId,
      p.sku,
      p.name,
      p.category,
      p.unit,
      p.safe_stock as safeStock,
      p.sale_price as salePrice,
      p.cost_price as costPrice,
      s.name as supplierName,
      s.lead_time_days as leadTimeDays,
      COALESCE(inv.currentStock, 0) as currentStock,
      COALESCE(transit.transitStock, 0) as transitStock
    FROM products p
    LEFT JOIN suppliers s ON s.id = p.preferred_supplier_id
    LEFT JOIN (
      SELECT product_id, SUM(current_stock) as currentStock
      FROM inventory
      GROUP BY product_id
    ) inv ON inv.product_id = p.id
    LEFT JOIN (
      SELECT
        poi.product_id as product_id,
        SUM(CASE WHEN poi.ordered_qty > poi.arrived_qty THEN poi.ordered_qty - poi.arrived_qty ELSE 0 END) as transitStock
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('采购中', '部分到货')
      GROUP BY product_id
    ) transit ON transit.product_id = p.id
    ORDER BY p.sku
  `).all();
}

function buildShelfSummaryMap() {
  const rows = db.prepare<{ productId: string; shelfSummary: string }>(`
    SELECT
      iss.product_id as productId,
      GROUP_CONCAT(ws.shelf_code, ' / ') as shelfSummary
    FROM inventory_shelf_stock iss
    JOIN warehouse_shelves ws ON ws.id = iss.shelf_id
    WHERE iss.quantity > 0
    GROUP BY iss.product_id
  `).all();

  return new Map(rows.map((row) => [row.productId, row.shelfSummary]));
}

export function listInventory() {
  const shelfSummaryMap = buildShelfSummaryMap();

  return baseInventoryRows().map((row) => ({
    id: row.sku,
    name: row.name,
    category: row.category,
    currentStock: row.currentStock,
    safeStock: row.safeStock,
    transitStock: row.transitStock,
    status: buildStatus(row.currentStock, row.safeStock),
    shelfSummary: shelfSummaryMap.get(row.productId) || '-',
  }));
}

export function getInventoryDetail(sku: string): InventoryDetailRecord | null {
  const normalizedSku = sku.trim().toUpperCase();
  if (!normalizedSku) {
    return null;
  }

  const baseRow = baseInventoryRows().find((row) => row.sku.toUpperCase() === normalizedSku);
  if (!baseRow) {
    return null;
  }

  const warehouseRows = db.prepare<{
    warehouseId: string;
    warehouseName: string;
    locationCode: string;
    currentStock: number;
    reservedStock: number;
  }>(`
    SELECT
      w.id as warehouseId,
      w.name as warehouseName,
      w.location_code as locationCode,
      i.current_stock as currentStock,
      i.reserved_stock as reservedStock
    FROM inventory i
    JOIN warehouses w ON w.id = i.warehouse_id
    WHERE i.product_id = ?
    ORDER BY w.name ASC
  `).all(baseRow.productId);

  const movementRows = db.prepare<{
    id: number;
    movementType: string;
    sourceType: string;
    sourceId: string;
    qtyChange: number;
    reservedChange: number;
    occurredAt: string;
    remark: string | null;
  }>(`
    SELECT
      id,
      movement_type as movementType,
      source_type as sourceType,
      source_id as sourceId,
      qty_change as qtyChange,
      reserved_change as reservedChange,
      occurred_at as occurredAt,
      remark
    FROM inventory_movements
    WHERE product_id = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT 24
  `).all(baseRow.productId);
  const shelfPlacements = getProductShelfPlacements(baseRow.productId);

  const recentMovements: InventoryMovementRecord[] = movementRows.map((item) => {
    let type: InventoryMovementRecord['type'] = '盘点';
    if (item.movementType === 'inbound') {
      type = '入库';
    } else if (item.movementType === 'outbound' || item.movementType === 'reverse') {
      type = '出库';
    }

    const quantity = item.qtyChange !== 0 ? item.qtyChange : item.reservedChange;
    const summary =
      item.remark ||
      (item.movementType === 'reserve'
        ? `订单预留 (${item.sourceId})`
        : item.movementType === 'release'
          ? `释放预留 (${item.sourceId})`
          : `${item.sourceType} / ${item.sourceId}`);

    return {
      id: `mov-${item.id}`,
      type,
      referenceId: item.sourceId,
      quantity,
      occurredAt: item.occurredAt,
      summary,
    };
  });

  return {
    id: baseRow.sku,
    name: baseRow.name,
    category: baseRow.category,
    currentStock: baseRow.currentStock,
    safeStock: baseRow.safeStock,
    transitStock: baseRow.transitStock,
    status: buildStatus(baseRow.currentStock, baseRow.safeStock),
    shelfSummary: shelfPlacements.map((item) => item.shelfCode).join(' / ') || '-',
    unit: baseRow.unit,
    salePrice: baseRow.salePrice,
    costPrice: baseRow.costPrice,
    preferredSupplier: baseRow.supplierName || '-',
    leadTimeDays: baseRow.leadTimeDays ?? 0,
    warehouses: warehouseRows,
    shelfPlacements,
    recentMovements,
  };
}

export function getInventoryAlerts() {
  return baseInventoryRows()
    .map((row) => ({
      sku: row.sku,
      name: row.name,
      currentStock: row.currentStock,
      safeStock: row.safeStock,
      transitStock: row.transitStock,
      gap: Math.max(row.safeStock - row.currentStock, 0),
      status: buildStatus(row.currentStock, row.safeStock),
    }))
    .filter((row) => row.status !== '正常')
    .sort((a, b) => b.gap - a.gap);
}

export function getInventoryOverview(): InventoryOverview {
  const rows = baseInventoryRows();
  const shelves = listWarehouseShelves();
  const totals = rows.reduce(
    (acc, row) => {
      acc.totalInventoryValue += row.currentStock * row.costPrice;
      acc.totalCurrentStock += row.currentStock;
      const status = buildStatus(row.currentStock, row.safeStock);
      if (status === '缺货') {
        acc.shortageCount += 1;
      } else if (status === '预警') {
        acc.warningCount += 1;
      }
      return acc;
    },
    { totalInventoryValue: 0, totalCurrentStock: 0, shortageCount: 0, warningCount: 0 }
  );

  const capacityUsageRate = getShelfUsageRate();

  return {
    totalInventoryValue: totals.totalInventoryValue,
    capacityUsageRate,
    shortageCount: totals.shortageCount,
    warningCount: totals.warningCount,
    totalSkus: rows.length,
    totalShelfCount: shelves.length,
    availableShelfCount: shelves.filter((item) => item.remainingCapacity > 0).length,
  };
}

export function listInventoryShelves(): InventoryShelfOverviewRecord[] {
  return listWarehouseShelves().map((shelf) => {
    let status: InventoryShelfOverviewRecord['status'] = '可用';
    if (shelf.usedQuantity === 0) {
      status = '空闲';
    } else if (shelf.remainingCapacity === 0) {
      status = '满位';
    } else if (shelf.remainingCapacity / Math.max(shelf.capacity, 1) < 0.2) {
      status = '紧张';
    }

    return {
      shelfId: shelf.id,
      warehouseId: shelf.warehouseId,
      warehouseName: shelf.warehouseName,
      shelfCode: shelf.shelfCode,
      shelfName: shelf.shelfName,
      tags: shelf.tags,
      capacity: shelf.capacity,
      usedQuantity: shelf.usedQuantity,
      remainingCapacity: shelf.remainingCapacity,
      itemCount: shelf.itemCount,
      status,
    };
  });
}

export function adjustInventory(payload: InventoryAdjustmentPayload) {
  const normalizedSku = payload.sku.trim().toUpperCase();
  const product = db.prepare<{ productId: string }>('SELECT id as productId FROM products WHERE UPPER(sku) = ?').get(normalizedSku);
  if (!product) {
    throw new Error('Product not found');
  }

  if (!Number.isInteger(payload.targetStock) || payload.targetStock < 0) {
    throw new Error('targetStock must be a non-negative integer');
  }

  const inventoryRow = db.prepare<{ currentStock: number }>(
    'SELECT current_stock as currentStock FROM inventory WHERE product_id = ? AND warehouse_id = ?'
  ).get(product.productId, DEFAULT_WAREHOUSE_ID);

  if (!inventoryRow) {
    throw new Error('Inventory record not found');
  }

  const reservedBefore = db.prepare<{ reservedStock: number }>(
    'SELECT reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?'
  ).get(product.productId, DEFAULT_WAREHOUSE_ID)?.reservedStock ?? 0;

  if (payload.targetStock < reservedBefore) {
    throw new Error(`targetStock cannot be less than reserved stock (${reservedBefore})`);
  }

  db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
    payload.targetStock,
    product.productId,
    DEFAULT_WAREHOUSE_ID,
  );
  rebalanceShelfStock(product.productId, DEFAULT_WAREHOUSE_ID, payload.targetStock);

  appendInventoryMovement({
    productId: product.productId,
    warehouseId: DEFAULT_WAREHOUSE_ID,
    movementType: 'adjust',
    sourceType: 'inventory_adjustment',
    sourceId: normalizedSku,
    qtyChange: payload.targetStock - inventoryRow.currentStock,
    reservedChange: 0,
    qtyBefore: inventoryRow.currentStock,
    qtyAfter: payload.targetStock,
    reservedBefore,
    reservedAfter: reservedBefore,
    occurredAt: new Date().toISOString(),
    remark: payload.reason?.trim() || '盘点调整',
  });

  appendAuditLog('adjust_inventory', 'inventory', normalizedSku, {
    previousStock: inventoryRow.currentStock,
    targetStock: payload.targetStock,
    warehouseId: DEFAULT_WAREHOUSE_ID,
    reason: payload.reason?.trim() || null,
  });

  return listInventory().find((item) => item.id.toUpperCase() === normalizedSku) as InventoryItem;
}

export function forceDeleteInventory(sku: string, options?: { aggressive?: boolean }) {
  const aggressive = Boolean(options?.aggressive);
  const normalizedSku = sku.trim().toUpperCase();
  if (!normalizedSku) {
    throw new Error('SKU is required');
  }

  const product = db
    .prepare<{ id: string; sku: string; name: string }>(
      'SELECT id, sku, name FROM products WHERE UPPER(sku) = ?',
    )
    .get(normalizedSku);
  if (!product) {
    throw new Error('Product not found');
  }

  const totalCurrentStock =
    db.prepare<{ total: number }>('SELECT COALESCE(SUM(current_stock), 0) as total FROM inventory WHERE product_id = ?').get(product.id)
      ?.total ?? 0;
  if (!aggressive && totalCurrentStock > 0) {
    throw new Error('Inventory still has stock. Enable aggressive delete to force remove.');
  }

  db.prepare('DELETE FROM inventory WHERE product_id = ?').run(product.id);
  db.prepare('DELETE FROM inventory_shelf_stock WHERE product_id = ?').run(product.id);
  appendAuditLog(aggressive ? 'delete_inventory_force' : 'delete_inventory', 'inventory', product.sku, {
    productId: product.id,
    productName: product.name,
    totalCurrentStock,
    aggressive,
  });

  return {
    sku: product.sku,
    deleted: true,
  };
}
