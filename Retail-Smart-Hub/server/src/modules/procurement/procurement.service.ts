import {
  appendAuditLog,
  appendInventoryMovement,
  createPayableForPurchaseOrder,
  db,
  nextDocumentId,
  nextMasterDataId,
} from '../../database/db';
import { addDays, currentDateString, formatCurrency } from '../../shared/format';
import { DEFAULT_WAREHOUSE_ID } from '../../shared/warehouse';

export interface ProcurementOrder {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: string;
  source: string;
}

export interface ProcurementOrderDetail {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: string;
  source: string;
  remark?: string;
  itemCount: number;
  items: Array<{
    id: string;
    sku: string;
    productName: string;
    orderedQty: number;
    arrivedQty: number;
    unitCost: number;
    lineAmount: number;
  }>;
}

interface ProcurementRow {
  id: string;
  supplier: string;
  createDate: string;
  expectedDate: string;
  status: string;
  amount: number;
  source: string;
  remark?: string | null;
}

interface ProcurementItemRow {
  id: string;
  sku: string;
  productName: string;
  orderedQty: number;
  arrivedQty: number;
  unitCost: number;
}

interface SuggestedItem {
  productId: string;
  sku: string;
  name: string;
  recommendQty: number;
  supplierId: string;
  supplierName: string;
  leadTimeDays: number;
  unitCost: number;
}

const ALLOWED_PROCUREMENT_STATUSES = new Set(['待审核', '采购中', '部分到货', '已完成', '已取消']);

export interface ProcurementSuggestionSummary {
  lowStockItemCount: number;
  recommendedOrderCount: number;
  recommendedSkus: string[];
  message: string;
}

export interface GeneratedPurchaseOrder {
  id: string;
  supplier: string;
  amount: string;
  itemCount: number;
  status: string;
}

export interface ProcurementFormSupplierOption {
  id: string;
  name: string;
  leadTimeDays: number;
}

export interface ProcurementFormProductOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  costPrice: number;
  preferredSupplierId: string;
  preferredSupplier: string;
}

export interface ProcurementFormOptions {
  suppliers: ProcurementFormSupplierOption[];
  products: ProcurementFormProductOption[];
}

export interface CreateProcurementNewProductPayload {
  name: string;
  sku?: string;
  salePrice?: number;
  category?: string;
  unit?: string;
  safeStock?: number;
}

export interface CreateProcurementOrderExistingItemPayload {
  mode: 'existing';
  productId: string;
  quantity: number;
  unitCost: number;
}

export interface CreateProcurementOrderNewItemPayload {
  mode: 'new';
  quantity: number;
  unitCost: number;
  newProduct: CreateProcurementNewProductPayload;
}

export type CreateProcurementOrderItemPayload =
  | CreateProcurementOrderExistingItemPayload
  | CreateProcurementOrderNewItemPayload;

export interface CreateProcurementOrderPayload {
  supplierId: string;
  expectedDate: string;
  remark?: string;
  items: CreateProcurementOrderItemPayload[];
}

interface ManualProcurementProductRow {
  id: string;
  sku: string;
  name: string;
  unit: string;
  costPrice: number;
  preferredSupplierId: string;
  preferredSupplier: string;
}

interface QuickCreateProductResult {
  id: string;
  sku: string;
  name: string;
}

function isValidDateString(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  return !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function normalizeOptionalText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveNextSku() {
  const rows = db.prepare<{ sku: string }>("SELECT sku FROM products WHERE sku LIKE 'SKU-%'").all();
  let maxSuffix = 999;

  rows.forEach((row) => {
    const match = /^SKU-(\d+)$/i.exec(row.sku.trim());
    if (!match) {
      return;
    }

    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > maxSuffix) {
      maxSuffix = parsed;
    }
  });

  let next = maxSuffix + 1;
  while (true) {
    const candidate = `SKU-${String(next).padStart(4, '0')}`;
    const existing = db.prepare<{ id: string }>('SELECT id FROM products WHERE sku = ?').get(candidate);
    if (!existing) {
      return candidate;
    }
    next += 1;
  }
}

function resolveProcurementSku(rawSku?: string) {
  const normalizedSku = normalizeOptionalText(rawSku).toUpperCase();
  if (!normalizedSku) {
    return resolveNextSku();
  }

  const existing = db.prepare<{ id: string }>('SELECT id FROM products WHERE sku = ?').get(normalizedSku);
  if (existing) {
    throw new Error(`SKU ${normalizedSku} already exists`);
  }

  return normalizedSku;
}

function getDefaultWarehouseId() {
  const configuredWarehouse = db.prepare<{ id: string }>('SELECT id FROM warehouses WHERE id = ?').get(DEFAULT_WAREHOUSE_ID);
  if (configuredWarehouse?.id) {
    return configuredWarehouse.id;
  }

  return db.prepare<{ id: string }>('SELECT id FROM warehouses ORDER BY id ASC LIMIT 1').get()?.id ?? null;
}

function createQuickProcurementProduct(
  supplierId: string,
  item: CreateProcurementOrderNewItemPayload,
): QuickCreateProductResult {
  const name = normalizeOptionalText(item.newProduct?.name);
  if (!name) {
    throw new Error('new product name is required');
  }

  const safeStock = item.newProduct?.safeStock ?? 0;
  if (!Number.isInteger(safeStock) || safeStock < 0) {
    throw new Error(`new product ${name} has invalid safeStock`);
  }

  const salePrice = item.newProduct?.salePrice ?? item.unitCost;
  if (!Number.isFinite(salePrice) || salePrice <= 0) {
    throw new Error(`new product ${name} has invalid salePrice`);
  }

  const sku = resolveProcurementSku(item.newProduct?.sku);
  const productId = nextMasterDataId('products', 'PRD');
  const inventoryId = nextMasterDataId('inventory', 'INV');
  const warehouseId = getDefaultWarehouseId();
  const category = normalizeOptionalText(item.newProduct?.category) || '采购新增';
  const unit = normalizeOptionalText(item.newProduct?.unit) || '件';

  db.prepare(
    `INSERT INTO products (
      id, sku, name, category, unit, status, safe_stock, sale_price, cost_price, preferred_supplier_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(productId, sku, name, category, unit, 'active', safeStock, salePrice, item.unitCost, supplierId);

  if (warehouseId) {
    db.prepare(
      'INSERT INTO inventory (id, product_id, warehouse_id, current_stock, reserved_stock) VALUES (?, ?, ?, ?, ?)',
    ).run(inventoryId, productId, warehouseId, 0, 0);
  }

  appendAuditLog('create_product_from_procurement', 'product', productId, {
    supplierId,
    sku,
    name,
  });

  return {
    id: productId,
    sku,
    name,
  };
}

function loadSuggestedItems() {
  return db.prepare<SuggestedItem>(`
    SELECT
      p.id as productId,
      p.sku,
      p.name,
      CASE
        WHEN (p.safe_stock * 2) - COALESCE(inv.currentStock, 0) - COALESCE(transit.transitStock, 0) > 0
        THEN (p.safe_stock * 2) - COALESCE(inv.currentStock, 0) - COALESCE(transit.transitStock, 0)
        ELSE 0
      END as recommendQty,
      s.id as supplierId,
      s.name as supplierName,
      s.lead_time_days as leadTimeDays,
      p.cost_price as unitCost
    FROM products p
    JOIN suppliers s ON s.id = p.preferred_supplier_id
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
    WHERE p.status = 'active'
      AND s.status = 'active'
      AND COALESCE(inv.currentStock, 0) + COALESCE(transit.transitStock, 0) < p.safe_stock
    ORDER BY recommendQty DESC, p.sku ASC
  `).all();
}

export function getProcurementFormOptions(): ProcurementFormOptions {
  const suppliers = db.prepare<ProcurementFormSupplierOption>(`
    SELECT
      id,
      name,
      lead_time_days as leadTimeDays
    FROM suppliers
    WHERE status = 'active'
    ORDER BY name COLLATE NOCASE ASC, id ASC
  `).all();

  const products = db.prepare<ManualProcurementProductRow>(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.unit,
      p.cost_price as costPrice,
      p.preferred_supplier_id as preferredSupplierId,
      s.name as preferredSupplier
    FROM products p
    JOIN suppliers s ON s.id = p.preferred_supplier_id
    WHERE p.status = 'active'
      AND s.status = 'active'
    ORDER BY s.name COLLATE NOCASE ASC, p.sku COLLATE NOCASE ASC, p.id ASC
  `).all();

  return {
    suppliers,
    products,
  };
}

export function listProcurementOrders() {
  const rows = db.prepare<ProcurementRow>(`
    SELECT
      po.id,
      s.name as supplier,
      po.created_at as createDate,
      po.expected_at as expectedDate,
      po.status,
      po.source,
      COALESCE(SUM(poi.ordered_qty * poi.unit_cost), 0) as amount
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    GROUP BY po.id, s.name, po.created_at, po.expected_at, po.status, po.source
    ORDER BY po.created_at DESC, po.id DESC
  `).all();

  return rows.map((row) => ({
    ...row,
    amount: formatCurrency(row.amount),
  }));
}

export function getProcurementOrderDetail(id: string): ProcurementOrderDetail | null {
  const row = db.prepare<ProcurementRow>(`
    SELECT
      po.id,
      s.name as supplier,
      po.created_at as createDate,
      po.expected_at as expectedDate,
      po.status,
      po.source,
      po.remark,
      COALESCE(SUM(poi.ordered_qty * poi.unit_cost), 0) as amount
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    WHERE po.id = ?
    GROUP BY po.id, s.name, po.created_at, po.expected_at, po.status, po.source, po.remark
  `).get(id);

  if (!row) {
    return null;
  }

  const items = db.prepare<ProcurementItemRow>(`
    SELECT
      poi.id,
      p.sku,
      p.name as productName,
      poi.ordered_qty as orderedQty,
      poi.arrived_qty as arrivedQty,
      poi.unit_cost as unitCost
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ?
    ORDER BY poi.id ASC
  `).all(id);

  return {
    id: row.id,
    supplier: row.supplier,
    createDate: row.createDate,
    expectedDate: row.expectedDate,
    status: row.status,
    amount: formatCurrency(row.amount),
    source: row.source,
    remark: row.remark ?? undefined,
    itemCount: items.reduce((sum, item) => sum + item.orderedQty, 0),
    items: items.map((item) => ({
      ...item,
      lineAmount: item.orderedQty * item.unitCost,
    })),
  };
}

export function getProcurementSuggestions(): ProcurementSuggestionSummary {
  const items = loadSuggestedItems();
  const suppliers = new Set(items.map((item) => item.supplierId));

  return {
    lowStockItemCount: items.length,
    recommendedOrderCount: suppliers.size,
    recommendedSkus: items.map((item) => item.sku),
    message:
      items.length > 0
        ? `检测到 ${items.length} 个商品低于安全库存，建议生成 ${suppliers.size} 张补货采购单。`
        : '当前库存健康，无需新增采购单。',
  };
}

export function createProcurementOrder(payload: CreateProcurementOrderPayload) {
  const supplierId = payload.supplierId.trim();
  const expectedDate = payload.expectedDate.trim();
  const remark = payload.remark?.trim() || null;

  if (!supplierId) {
    throw new Error('supplierId is required');
  }

  if (!expectedDate || !isValidDateString(expectedDate)) {
    throw new Error('expectedDate must be a valid YYYY-MM-DD date');
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('items must contain at least one line');
  }

  const uniqueProductIds = new Set<string>();
  payload.items.forEach((item, index) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`items[${index}].quantity must be a positive integer`);
    }

    if (!Number.isFinite(item.unitCost) || item.unitCost <= 0) {
      throw new Error(`items[${index}].unitCost must be greater than 0`);
    }

    if (item.mode === 'existing') {
      if (!item.productId?.trim()) {
        throw new Error(`items[${index}].productId is required`);
      }
      if (uniqueProductIds.has(item.productId.trim())) {
        throw new Error('duplicate product lines are not allowed');
      }
      uniqueProductIds.add(item.productId.trim());
      return;
    }

    if (item.mode === 'new') {
      if (!normalizeOptionalText(item.newProduct?.name)) {
        throw new Error(`items[${index}].newProduct.name is required`);
      }
      return;
    }

    throw new Error(`items[${index}].mode is invalid`);
  });

  const supplier = db.prepare<{ id: string; name: string }>(
    "SELECT id, name FROM suppliers WHERE id = ? AND status = 'active'",
  ).get(supplierId);
  if (!supplier) {
    throw new Error('Active supplier not found');
  }

  const existingItems = payload.items.filter(
    (item): item is CreateProcurementOrderExistingItemPayload => item.mode === 'existing',
  );
  const productIds = existingItems.map((item) => item.productId.trim());
  const products = productIds.length
    ? db.prepare<ManualProcurementProductRow>(`
        SELECT
          p.id,
          p.sku,
          p.name,
          p.unit,
          p.cost_price as costPrice,
          p.preferred_supplier_id as preferredSupplierId,
          s.name as preferredSupplier
        FROM products p
        JOIN suppliers s ON s.id = p.preferred_supplier_id
        WHERE p.id IN (${productIds.map(() => '?').join(', ')})
          AND p.status = 'active'
          AND s.status = 'active'
      `).all(...productIds)
    : [];

  if (products.length !== productIds.length) {
    throw new Error('Some selected products are missing or inactive');
  }

  const productMap = new Map(products.map((product) => [product.id, product]));
  existingItems.forEach((item) => {
    const product = productMap.get(item.productId.trim());
    if (!product) {
      throw new Error(`Product ${item.productId} is not available`);
    }
    if (product.preferredSupplierId !== supplierId) {
      throw new Error(`Product ${product.sku} does not belong to the selected supplier`);
    }
  });

  const today = currentDateString();
  const poId = nextDocumentId('purchase_orders', 'PO', today);

  const transaction = db.transaction(() => {
    const createdProducts: QuickCreateProductResult[] = [];

    db.prepare(
      'INSERT INTO purchase_orders (id, supplier_id, created_at, expected_at, status, source, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(poId, supplierId, today, expectedDate, '待审核', '手工创建', remark);

    const insertItem = db.prepare(
      'INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, arrived_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
    );

    payload.items.forEach((item, index) => {
      const productId =
        item.mode === 'existing'
          ? item.productId.trim()
          : (() => {
              const created = createQuickProcurementProduct(supplierId, item);
              createdProducts.push(created);
              return created.id;
            })();

      insertItem.run(`${poId}-ITEM-${index + 1}`, poId, productId, item.quantity, 0, item.unitCost);
    });

    createPayableForPurchaseOrder(poId, {
      seedByStatus: false,
      remark: '采购单创建后自动生成应付记录。',
    });

    appendAuditLog('create_purchase_order_manual', 'purchase_order', poId, {
      supplierId,
      supplierName: supplier.name,
      itemCount: payload.items.length,
      expectedDate,
      remark,
      createdProducts,
    });
  });

  transaction();
  return getProcurementOrderDetail(poId) as ProcurementOrderDetail;
}

export function generateSuggestedPurchaseOrders() {
  const items = loadSuggestedItems();
  if (items.length === 0) {
    return [] as GeneratedPurchaseOrder[];
  }

  const today = currentDateString();
  const groups = new Map<string, SuggestedItem[]>();
  items.forEach((item) => {
    const current = groups.get(item.supplierId) ?? [];
    current.push(item);
    groups.set(item.supplierId, current);
  });

  const transaction = db.transaction(() => {
    const created: GeneratedPurchaseOrder[] = [];
    const insertPo = db.prepare(
      'INSERT INTO purchase_orders (id, supplier_id, created_at, expected_at, status, source, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertItem = db.prepare(
      'INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, arrived_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
    );

    groups.forEach((supplierItems, supplierId) => {
      const poId = nextDocumentId('purchase_orders', 'PO', today);
      const expectedDate = addDays(today, supplierItems[0].leadTimeDays);
      const totalAmount = supplierItems.reduce((sum, item) => sum + item.recommendQty * item.unitCost, 0);

      insertPo.run(
        poId,
        supplierId,
        today,
        expectedDate,
        '待审核',
        '低库存自动补货',
        `由系统自动生成，包含 ${supplierItems.length} 个补货 SKU。`,
      );

      supplierItems.forEach((item, index) => {
        insertItem.run(`${poId}-ITEM-${index + 1}`, poId, item.productId, item.recommendQty, 0, item.unitCost);
      });

      createPayableForPurchaseOrder(poId, {
        seedByStatus: false,
        remark: '采购单创建后自动生成应付记录。',
      });

      appendAuditLog('create_purchase_order', 'purchase_order', poId, {
        source: 'low_stock_auto_generation',
        supplierId,
        skuList: supplierItems.map((item) => item.sku),
      });

      created.push({
        id: poId,
        supplier: supplierItems[0].supplierName,
        amount: formatCurrency(totalAmount),
        itemCount: supplierItems.length,
        status: '待审核',
      });
    });

    return created;
  });

  return transaction();
}

export function updateProcurementOrderStatus(id: string, nextStatus: string) {
  if (!ALLOWED_PROCUREMENT_STATUSES.has(nextStatus)) {
    throw new Error('Unsupported procurement status');
  }

  const existing = db.prepare<{ id: string; status: string }>('SELECT id, status FROM purchase_orders WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('Procurement order not found');
  }

  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(nextStatus, id);
  appendAuditLog('force_update_purchase_order_status', 'purchase_order', id, {
    previousStatus: existing.status,
    nextStatus,
  });

  return getProcurementOrderDetail(id);
}

export function deleteProcurementOrder(id: string, options?: { aggressive?: boolean }) {
  const aggressive = Boolean(options?.aggressive);
  const existing = db.prepare<{ id: string; status: string }>('SELECT id, status FROM purchase_orders WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('Procurement order not found');
  }

  const transaction = db.transaction(() => {
    const receivingCount =
      db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM receiving_notes WHERE purchase_order_id = ?').get(id)?.count ?? 0;
    if (!aggressive && receivingCount > 0) {
      throw new Error('Procurement order has receiving records. Enable aggressive delete to force remove.');
    }

    const inboundRows = db
      .prepare<{ id: string; status: string; receivingNoteId: string; warehouseId: string }>(`
        SELECT
          io.id as id,
          io.status as status,
          io.receiving_note_id as receivingNoteId,
          io.warehouse_id as warehouseId
        FROM inbound_orders io
        JOIN receiving_notes rn ON rn.id = io.receiving_note_id
        WHERE rn.purchase_order_id = ?
      `)
      .all(id);

    inboundRows.forEach((inbound) => {
      if (inbound.status !== '已入库') {
        return;
      }

      const items = db
        .prepare<{ productId: string; qualifiedQty: number }>(
          'SELECT product_id as productId, qualified_qty as qualifiedQty FROM receiving_note_items WHERE receiving_note_id = ?',
        )
        .all(inbound.receivingNoteId);

      items.forEach((item) => {
        const warehouseId = inbound.warehouseId || DEFAULT_WAREHOUSE_ID;
        const stock = db
          .prepare<{ currentStock: number; reservedStock: number }>(
            'SELECT current_stock as currentStock, reserved_stock as reservedStock FROM inventory WHERE product_id = ? AND warehouse_id = ?',
          )
          .get(item.productId, warehouseId);

        if (!stock) {
          throw new Error(`Inventory record missing while rolling back procurement ${id}`);
        }
        if (stock.currentStock < item.qualifiedQty) {
          throw new Error(
            `Inventory inconsistency for rollback: product ${item.productId} current=${stock.currentStock}, rollback=${item.qualifiedQty}`,
          );
        }

        const qtyAfter = stock.currentStock - item.qualifiedQty;
        db.prepare('UPDATE inventory SET current_stock = ? WHERE product_id = ? AND warehouse_id = ?').run(
          qtyAfter,
          item.productId,
          warehouseId,
        );

        appendInventoryMovement({
          productId: item.productId,
          warehouseId,
          movementType: 'reverse',
          sourceType: 'purchase_order',
          sourceId: id,
          qtyChange: -item.qualifiedQty,
          reservedChange: 0,
          qtyBefore: stock.currentStock,
          qtyAfter,
          reservedBefore: stock.reservedStock,
          reservedAfter: stock.reservedStock,
          occurredAt: new Date().toISOString(),
          remark: `删除采购单回滚入库 ${inbound.receivingNoteId}`,
        });
      });
    });

    db.prepare(`
      DELETE FROM inbound_orders
      WHERE receiving_note_id IN (
        SELECT id FROM receiving_notes WHERE purchase_order_id = ?
      )
    `).run(id);

    const payableIds = db
      .prepare<{ id: string }>('SELECT id FROM payables WHERE purchase_order_id = ?')
      .all(id)
      .map((item) => item.id);
    payableIds.forEach((payableId) => {
      db.prepare('DELETE FROM payment_records WHERE payable_id = ?').run(payableId);
    });
    db.prepare('DELETE FROM payables WHERE purchase_order_id = ?').run(id);
    db.prepare('DELETE FROM receiving_notes WHERE purchase_order_id = ?').run(id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);

    appendAuditLog(aggressive ? 'delete_purchase_order_force' : 'delete_purchase_order', 'purchase_order', id, {
      previousStatus: existing.status,
      removedInboundCount: inboundRows.length,
      aggressive,
    });
  });

  transaction();

  return {
    id,
    deleted: true,
  };
}
