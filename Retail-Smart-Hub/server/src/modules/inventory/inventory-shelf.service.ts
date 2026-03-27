import { db, nextDocumentId } from '../../database/db';

export interface WarehouseShelfRecord {
  id: string;
  warehouseId: string;
  warehouseName: string;
  shelfCode: string;
  shelfName: string;
  tags: string[];
  capacity: number;
  usedQuantity: number;
  remainingCapacity: number;
  itemCount: number;
  sortOrder: number;
}

interface WarehouseShelfRow {
  id: string;
  warehouseId: string;
  warehouseName: string;
  shelfCode: string;
  shelfName: string;
  tags: string | null;
  capacity: number;
  sortOrder: number;
  usedQuantity: number;
  itemCount: number;
}

interface ShelfStockRow {
  id: string;
  shelfId: string;
  quantity: number;
}

function parseTags(value?: string | null) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeShelfRow(row: WarehouseShelfRow): WarehouseShelfRecord {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    shelfCode: row.shelfCode,
    shelfName: row.shelfName,
    tags: parseTags(row.tags),
    capacity: row.capacity,
    usedQuantity: row.usedQuantity,
    remainingCapacity: Math.max(row.capacity - row.usedQuantity, 0),
    itemCount: row.itemCount,
    sortOrder: row.sortOrder,
  };
}

export function listWarehouseShelves(warehouseId?: string) {
  const sql = `
    SELECT
      ws.id,
      ws.warehouse_id as warehouseId,
      w.name as warehouseName,
      ws.shelf_code as shelfCode,
      ws.shelf_name as shelfName,
      ws.tags,
      ws.capacity,
      ws.sort_order as sortOrder,
      COALESCE(SUM(iss.quantity), 0) as usedQuantity,
      COUNT(DISTINCT CASE WHEN iss.quantity > 0 THEN iss.product_id END) as itemCount
    FROM warehouse_shelves ws
    JOIN warehouses w ON w.id = ws.warehouse_id
    LEFT JOIN inventory_shelf_stock iss ON iss.shelf_id = ws.id
    ${warehouseId ? 'WHERE ws.warehouse_id = ?' : ''}
    GROUP BY ws.id, ws.warehouse_id, w.name, ws.shelf_code, ws.shelf_name, ws.tags, ws.capacity, ws.sort_order
    ORDER BY ws.warehouse_id ASC, ws.sort_order ASC, ws.shelf_code ASC
  `;

  const rows = warehouseId
    ? db.prepare<WarehouseShelfRow>(sql).all(warehouseId)
    : db.prepare<WarehouseShelfRow>(sql).all();

  return rows.map(normalizeShelfRow);
}

export function getWarehouseShelf(shelfId: string) {
  const row = db.prepare<WarehouseShelfRow>(`
    SELECT
      ws.id,
      ws.warehouse_id as warehouseId,
      w.name as warehouseName,
      ws.shelf_code as shelfCode,
      ws.shelf_name as shelfName,
      ws.tags,
      ws.capacity,
      ws.sort_order as sortOrder,
      COALESCE(SUM(iss.quantity), 0) as usedQuantity,
      COUNT(DISTINCT CASE WHEN iss.quantity > 0 THEN iss.product_id END) as itemCount
    FROM warehouse_shelves ws
    JOIN warehouses w ON w.id = ws.warehouse_id
    LEFT JOIN inventory_shelf_stock iss ON iss.shelf_id = ws.id
    WHERE ws.id = ?
    GROUP BY ws.id, ws.warehouse_id, w.name, ws.shelf_code, ws.shelf_name, ws.tags, ws.capacity, ws.sort_order
  `).get(shelfId);

  return row ? normalizeShelfRow(row) : null;
}

function getShelfStockRow(productId: string, warehouseId: string, shelfId: string) {
  return db.prepare<ShelfStockRow>(
    'SELECT id, shelf_id as shelfId, quantity FROM inventory_shelf_stock WHERE product_id = ? AND warehouse_id = ? AND shelf_id = ?',
  ).get(productId, warehouseId, shelfId);
}

function getShelfUsage(shelfId: string) {
  return (
    db.prepare<{ total: number }>(
      'SELECT COALESCE(SUM(quantity), 0) as total FROM inventory_shelf_stock WHERE shelf_id = ?',
    ).get(shelfId)?.total ?? 0
  );
}

export function ensureShelfHasCapacity(shelfId: string, quantityDelta: number) {
  const shelf = getWarehouseShelf(shelfId);
  if (!shelf) {
    throw new Error('Shelf not found');
  }

  if (quantityDelta <= 0) {
    return shelf;
  }

  if (shelf.usedQuantity + quantityDelta > shelf.capacity) {
    throw new Error(`货架 ${shelf.shelfCode} 容量不足，可用余量 ${shelf.remainingCapacity}`);
  }

  return shelf;
}

export function updateShelfStock(productId: string, warehouseId: string, shelfId: string, quantityDelta: number) {
  const existing = getShelfStockRow(productId, warehouseId, shelfId);
  const nextQuantity = (existing?.quantity ?? 0) + quantityDelta;

  if (nextQuantity < 0) {
    throw new Error('Shelf stock cannot be negative');
  }

  if (quantityDelta > 0) {
    ensureShelfHasCapacity(shelfId, quantityDelta);
  }

  if (!existing && nextQuantity > 0) {
    db.prepare(
      'INSERT INTO inventory_shelf_stock (id, product_id, warehouse_id, shelf_id, quantity) VALUES (?, ?, ?, ?, ?)',
    ).run(nextDocumentId('inventory_shelf_stock', 'SLT'), productId, warehouseId, shelfId, nextQuantity);
    return;
  }

  if (!existing) {
    return;
  }

  if (nextQuantity === 0) {
    db.prepare('DELETE FROM inventory_shelf_stock WHERE id = ?').run(existing.id);
    return;
  }

  db.prepare('UPDATE inventory_shelf_stock SET quantity = ? WHERE id = ?').run(nextQuantity, existing.id);
}

export function allocateOutboundFromShelves(productId: string, warehouseId: string, quantity: number) {
  if (quantity <= 0) {
    return [];
  }

  const shelfStocks = db.prepare<ShelfStockRow>(`
    SELECT
      iss.id,
      iss.shelf_id as shelfId,
      iss.quantity
    FROM inventory_shelf_stock iss
    JOIN warehouse_shelves ws ON ws.id = iss.shelf_id
    WHERE iss.product_id = ? AND iss.warehouse_id = ? AND iss.quantity > 0
    ORDER BY iss.quantity DESC, ws.sort_order ASC, ws.shelf_code ASC
  `).all(productId, warehouseId);

  let remaining = quantity;
  const allocations: Array<{ shelfId: string; quantity: number }> = [];

  for (const stock of shelfStocks) {
    if (remaining <= 0) {
      break;
    }

    const consumed = Math.min(stock.quantity, remaining);
    updateShelfStock(productId, warehouseId, stock.shelfId, -consumed);
    allocations.push({ shelfId: stock.shelfId, quantity: consumed });
    remaining -= consumed;
  }

  if (remaining > 0) {
    throw new Error('Shelf stock is insufficient for outbound');
  }

  return allocations;
}

export function rebalanceShelfStock(productId: string, warehouseId: string, targetStock: number) {
  const currentStock =
    db.prepare<{ total: number }>(
      'SELECT COALESCE(SUM(quantity), 0) as total FROM inventory_shelf_stock WHERE product_id = ? AND warehouse_id = ?',
    ).get(productId, warehouseId)?.total ?? 0;

  if (currentStock === targetStock) {
    return;
  }

  if (currentStock > targetStock) {
    allocateOutboundFromShelves(productId, warehouseId, currentStock - targetStock);
    return;
  }

  const delta = targetStock - currentStock;
  const shelves = listWarehouseShelves(warehouseId).filter((shelf) => shelf.remainingCapacity > 0);
  if (shelves.length === 0) {
    throw new Error('No shelf capacity available for inventory adjustment');
  }

  let remaining = delta;
  for (const shelf of shelves) {
    if (remaining <= 0) {
      break;
    }

    const assigned = Math.min(shelf.remainingCapacity, remaining);
    updateShelfStock(productId, warehouseId, shelf.id, assigned);
    remaining -= assigned;
  }

  if (remaining > 0) {
    throw new Error('Shelf capacity is insufficient for inventory adjustment');
  }
}

export function suggestShelfForProduct(productId: string, warehouseId: string) {
  const product = db.prepare<{ name: string; category: string }>(
    'SELECT name, category FROM products WHERE id = ?',
  ).get(productId);
  if (!product) {
    return null;
  }

  const text = `${product.name} ${product.category}`.toLowerCase();
  const shelves = listWarehouseShelves(warehouseId).filter((shelf) => shelf.remainingCapacity > 0);
  if (shelves.length === 0) {
    return null;
  }

  const scored = shelves
    .map((shelf) => {
      const score = shelf.tags.reduce((sum, tag) => (text.includes(tag.toLowerCase()) ? sum + 5 : sum), 0) + shelf.remainingCapacity / 100;
      return { shelf, score };
    })
    .sort((left, right) => right.score - left.score || right.shelf.remainingCapacity - left.shelf.remainingCapacity);

  return scored[0]?.shelf || shelves[0];
}

export function getShelfUsageRate() {
  const totals = db.prepare<{ capacity: number; used: number }>(`
    SELECT
      COALESCE(SUM(ws.capacity), 0) as capacity,
      COALESCE(SUM(iss.quantity), 0) as used
    FROM warehouse_shelves ws
    LEFT JOIN inventory_shelf_stock iss ON iss.shelf_id = ws.id
  `).get();

  if (!totals || totals.capacity <= 0) {
    return 0;
  }

  return Math.min((totals.used / totals.capacity) * 100, 100);
}

export function getProductShelfPlacements(productId: string) {
  return db.prepare<{
    shelfId: string;
    warehouseId: string;
    warehouseName: string;
    shelfCode: string;
    shelfName: string;
    tags: string | null;
    quantity: number;
    capacity: number;
  }>(`
    SELECT
      iss.shelf_id as shelfId,
      iss.warehouse_id as warehouseId,
      w.name as warehouseName,
      ws.shelf_code as shelfCode,
      ws.shelf_name as shelfName,
      ws.tags,
      iss.quantity,
      ws.capacity
    FROM inventory_shelf_stock iss
    JOIN warehouse_shelves ws ON ws.id = iss.shelf_id
    JOIN warehouses w ON w.id = iss.warehouse_id
    WHERE iss.product_id = ? AND iss.quantity > 0
    ORDER BY w.name ASC, ws.sort_order ASC, ws.shelf_code ASC
  `).all(productId).map((row) => ({
    shelfId: row.shelfId,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    shelfCode: row.shelfCode,
    shelfName: row.shelfName,
    tags: parseTags(row.tags),
    quantity: row.quantity,
    capacity: row.capacity,
    remainingCapacity: Math.max(row.capacity - getShelfUsage(row.shelfId), 0),
  }));
}
