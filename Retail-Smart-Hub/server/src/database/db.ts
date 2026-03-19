import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { runAuthSecurityMigrations, runSalesOrderBusinessMigrations } from './migrations/core.migrations';
import { getTableCount, ensureColumnExists as ensureColumnExistsInSchema } from './repositories/schema.repository';
import { seedBootstrapData } from './seeds/core.seed';
import { env } from '../config/env';
import { addDays, compactDate, currentDateString } from '../shared/format';
import { generateTemporaryPassword, hashPassword } from '../shared/password';

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

class StatementWrapper<T = unknown> {
  constructor(private readonly statement: StatementSync) {}

  run(...params: unknown[]) {
    const result = this.statement.run(...(params as SQLInputValue[]));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: result.lastInsertRowid ?? 0,
    } as RunResult;
  }

  get(...params: unknown[]) {
    return this.statement.get(...(params as SQLInputValue[])) as T | undefined;
  }

  all(...params: unknown[]) {
    return this.statement.all(...(params as SQLInputValue[])) as T[];
  }
}

class DatabaseWrapper {
  private readonly database: DatabaseSync;
  private savepointCounter = 0;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  pragma(statement: string) {
    this.database.exec(`PRAGMA ${statement}`);
  }

  prepare<T = unknown>(sql: string) {
    return new StatementWrapper<T>(this.database.prepare(sql));
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
    return (...args: TArgs) => {
      const savepoint = `ai_txn_${this.savepointCounter += 1}`;
      this.database.exec(`SAVEPOINT ${savepoint}`);

      try {
        const result = fn(...args);
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // Ignore rollback failures and preserve the original error.
        }
        throw error;
      }
    };
  }
}

const configuredDataDir = process.env.RETAIL_SMART_HUB_DATA_DIR?.trim();
export const databaseDir = configuredDataDir ? path.resolve(configuredDataDir) : path.resolve(process.cwd(), 'database');
export const databasePath = path.join(databaseDir, 'retail-smart-hub.db');
const bootstrapAdminPasswordPath = path.join(databaseDir, 'bootstrap-admin-password.txt');

fs.mkdirSync(databaseDir, { recursive: true });

export const db = new DatabaseWrapper(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function persistBootstrapAdminPassword(password: string) {
  const issuedAt = new Date().toISOString();
  const payload = [
    'Retail Smart Hub bootstrap administrator password',
    `issuedAt=${issuedAt}`,
    'username=admin',
    `temporaryPassword=${password}`,
    'mustChangePassword=true',
    'deleteThisFileAfterFirstLogin=true',
    '',
  ].join('\n');
  fs.writeFileSync(bootstrapAdminPasswordPath, payload, 'utf8');
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      lead_time_days INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location_code TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      safe_stock INTEGER NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL DEFAULT 0,
      preferred_supplier_id TEXT,
      FOREIGN KEY (preferred_supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      current_stock INTEGER NOT NULL DEFAULT 0,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_product_warehouse ON inventory(product_id, warehouse_id);

    CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      order_channel TEXT NOT NULL,
      order_date TEXT NOT NULL,
      expected_delivery_date TEXT NOT NULL,
      status TEXT NOT NULL,
      stock_status TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      remark TEXT,
      source_order_no TEXT,
      source_system TEXT,
      biz_no TEXT,
      idempotency_key TEXT
    );

    CREATE TABLE IF NOT EXISTS sales_order_items (
      id TEXT PRIMARY KEY,
      sales_order_id TEXT NOT NULL,
      product_id TEXT,
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expected_at TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      remark TEXT,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      ordered_qty INTEGER NOT NULL,
      arrived_qty INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL,
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS receiving_notes (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      expected_qty INTEGER NOT NULL,
      arrived_qty INTEGER NOT NULL,
      qualified_qty INTEGER NOT NULL,
      defect_qty INTEGER NOT NULL,
      status TEXT NOT NULL,
      arrived_at TEXT NOT NULL,
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS receiving_note_items (
      id TEXT PRIMARY KEY,
      receiving_note_id TEXT NOT NULL,
      purchase_order_item_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      expected_qty INTEGER NOT NULL,
      arrived_qty INTEGER NOT NULL,
      qualified_qty INTEGER NOT NULL,
      defect_qty INTEGER NOT NULL,
      FOREIGN KEY (receiving_note_id) REFERENCES receiving_notes(id) ON DELETE CASCADE,
      FOREIGN KEY (purchase_order_item_id) REFERENCES purchase_order_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS inbound_orders (
      id TEXT PRIMARY KEY,
      receiving_note_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      inbound_qty INTEGER NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (receiving_note_id) REFERENCES receiving_notes(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS delivery_notes (
      id TEXT PRIMARY KEY,
      sales_order_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      shipment_status TEXT NOT NULL,
      courier TEXT,
      tracking_no TEXT,
      shipped_at TEXT,
      remark TEXT,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id)
    );

    CREATE TABLE IF NOT EXISTS stock_out_records (
      id TEXT PRIMARY KEY,
      delivery_note_id TEXT NOT NULL,
      sales_order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (delivery_note_id) REFERENCES delivery_notes(id),
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS stock_reservations (
      id TEXT PRIMARY KEY,
      sales_order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      UNIQUE (sales_order_id, product_id, warehouse_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      qty_change INTEGER NOT NULL DEFAULT 0,
      reserved_change INTEGER NOT NULL DEFAULT 0,
      qty_before INTEGER NOT NULL,
      qty_after INTEGER NOT NULL,
      reserved_before INTEGER NOT NULL DEFAULT 0,
      reserved_after INTEGER NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL,
      operator_id TEXT,
      remark TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_warehouse_time
      ON inventory_movements(product_id, warehouse_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS receivables (
      id TEXT PRIMARY KEY,
      sales_order_id TEXT NOT NULL UNIQUE,
      amount_due REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL,
      last_received_at TEXT,
      remark TEXT,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id)
    );

    CREATE TABLE IF NOT EXISTS receipt_records (
      id TEXT PRIMARY KEY,
      receivable_id TEXT NOT NULL,
      amount REAL NOT NULL,
      received_at TEXT NOT NULL,
      method TEXT NOT NULL,
      remark TEXT,
      FOREIGN KEY (receivable_id) REFERENCES receivables(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payables (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL UNIQUE,
      amount_due REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL,
      last_paid_at TEXT,
      remark TEXT,
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id)
    );

    CREATE TABLE IF NOT EXISTS payment_records (
      id TEXT PRIMARY KEY,
      payable_id TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_at TEXT NOT NULL,
      method TEXT NOT NULL,
      remark TEXT,
      FOREIGN KEY (payable_id) REFERENCES payables(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      scope TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      module_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      department TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_credentials (
      user_id TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT NOT NULL UNIQUE,
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_security_state (
      user_id TEXT PRIMARY KEY,
      failed_attempt_count INTEGER NOT NULL DEFAULT 0,
      last_failed_at TEXT,
      locked_until TEXT,
      password_updated_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      user_id TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      attempted_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      channel_preference TEXT,
      contact_name TEXT,
      phone TEXT,
      level TEXT NOT NULL DEFAULT 'B',
      last_order_date TEXT,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_sales REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_pending_actions (
      id TEXT PRIMARY KEY,
      action_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      username TEXT NOT NULL,
      required_permission TEXT NOT NULL,
      payload TEXT NOT NULL,
      summary TEXT NOT NULL,
      confirmation_message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      cancelled_at TEXT,
      executed_at TEXT,
      undo_supported INTEGER NOT NULL DEFAULT 0,
      execution_result TEXT,
      undone_at TEXT
    );
  `);

  ensureMasterDataStatusColumns();
  ensureAuthSecuritySchema();
  ensureAiPendingActionSchema();
  ensureSalesOrderTimeSchema();
  ensureSalesOrderBusinessSchema();

  const existingProducts = getTableCount(db, 'products');
  if (existingProducts > 0) {
    ensureSalesOrderTimeSchema();
    ensureSalesOrderBusinessSchema();
    ensureDeliveryNotes();
    ensureAccessControlData();
    ensureAuthSecurityData();
    ensureCustomerProfiles();
    return;
  }

  seedBootstrapData(db);
  ensureSalesOrderTimeSchema();
  ensureSalesOrderBusinessSchema();
  ensureDeliveryNotes();
  ensureFinanceDocuments();
  ensureAccessControlData();
  ensureAuthSecurityData();
  ensureCustomerProfiles();
}

function ensureColumnExists(tableName: string, columnName: string, definition: string) {
  ensureColumnExistsInSchema(db, tableName, columnName, definition);
}

function ensureMasterDataStatusColumns() {
  ensureColumnExists('products', 'status', "status TEXT NOT NULL DEFAULT 'active'");
  db.exec("UPDATE products SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
  db.exec("UPDATE suppliers SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
}

function ensureAuthSecuritySchema() {
  runAuthSecurityMigrations({
    ensureColumnExists,
    exec: (sql) => db.exec(sql),
    currentDate: currentDateString(),
  });
}

function ensureAiPendingActionSchema() {
  ensureColumnExists('ai_pending_actions', 'undo_supported', 'undo_supported INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('ai_pending_actions', 'execution_result', 'execution_result TEXT');
  ensureColumnExists('ai_pending_actions', 'undone_at', 'undone_at TEXT');
}

function ensureSalesOrderTimeSchema() {
  ensureColumnExists('sales_orders', 'created_at', 'created_at TEXT');
  db.exec(`
    UPDATE sales_orders
    SET created_at = CASE
      WHEN instr(order_date, 'T') > 0 THEN order_date
      ELSE order_date || 'T09:00:00.000Z'
    END
    WHERE created_at IS NULL OR TRIM(created_at) = ''
  `);
}

function ensureSalesOrderBusinessSchema() {
  runSalesOrderBusinessMigrations({
    ensureColumnExists,
    exec: (sql) => db.exec(sql),
  });
}

export function ensureAuthSecurityData() {
  const users = db.prepare<{ id: string }>('SELECT id FROM users').all();
  if (users.length === 0) {
    return;
  }

  const insertState = db.prepare(
    `INSERT OR IGNORE INTO auth_security_state (
      user_id, failed_attempt_count, last_failed_at, locked_until, password_updated_at
    ) VALUES (?, 0, NULL, NULL, ?)`
  );

  const passwordRows = db.prepare<{ userId: string; passwordUpdatedAt: string | null }>(
    'SELECT user_id as userId, password_updated_at as passwordUpdatedAt FROM user_credentials'
  ).all();
  const passwordUpdatedAtByUserId = new Map(
    passwordRows.map((row) => [row.userId, row.passwordUpdatedAt || `${currentDateString()}T00:00:00.000Z`])
  );

  const transaction = db.transaction(() => {
    users.forEach((user) => {
      insertState.run(user.id, passwordUpdatedAtByUserId.get(user.id) || `${currentDateString()}T00:00:00.000Z`);
    });
  });

  transaction();
}

interface MissingDeliveryOrderRow {
  id: string;
  orderDate: string;
  orderChannel: string;
  status: string;
}

interface MissingReceivableRow {
  id: string;
  orderDate: string;
  expectedDeliveryDate: string;
  status: string;
  totalAmount: number;
}

interface MissingPayableRow {
  id: string;
  createdAt: string;
  expectedAt: string;
  status: string;
  amount: number;
}

interface CustomerAggregateRow {
  name: string;
  orderChannel: string;
  lastOrderDate: string;
  totalOrders: number;
  totalSales: number;
}

function inferCourier(orderChannel: string) {
  if (orderChannel === '线上商城') {
    return '顺丰速运';
  }

  if (orderChannel === '企业团购') {
    return '德邦物流';
  }

  return '门店配送';
}

function buildTrackingNumber(deliveryId: string) {
  return `TRK-${deliveryId.replaceAll('-', '')}`;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

interface CreateReceivableOptions {
  remark?: string | null;
  seedByStatus?: boolean;
}

interface CreatePayableOptions {
  remark?: string | null;
  seedByStatus?: boolean;
}

export interface FinanceSyncResult {
  receivablesCreated: number;
  payablesCreated: number;
}

export interface InventoryMovementPayload {
  productId: string;
  warehouseId: string;
  movementType: 'reserve' | 'release' | 'inbound' | 'outbound' | 'adjust' | 'reverse';
  sourceType: string;
  sourceId: string;
  qtyChange: number;
  reservedChange: number;
  qtyBefore: number;
  qtyAfter: number;
  reservedBefore: number;
  reservedAfter: number;
  occurredAt?: string;
  operatorId?: string | null;
  remark?: string | null;
}

const MASTER_DATA_ID_TABLES = new Set([
  'users',
  'roles',
  'permissions',
  'customers',
  'suppliers',
  'products',
  'inventory',
  'warehouses',
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSupportedMasterDataTable(tableName: string) {
  if (!MASTER_DATA_ID_TABLES.has(tableName)) {
    throw new Error(`Unsupported master data id table: ${tableName}`);
  }
}

export function nextMasterDataId(tableName: string, prefix: string) {
  assertSupportedMasterDataTable(tableName);
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) {
    throw new Error('Master data id prefix is required');
  }

  // Avoid COUNT(*)+1 collisions after deletes by using the maximum numeric suffix instead.
  const like = `${normalizedPrefix}-%`;
  const rows = db.prepare<{ id: string }>(`SELECT id FROM ${tableName} WHERE id LIKE ?`).all(like);
  const matcher = new RegExp(`^${escapeRegExp(normalizedPrefix)}-(\\d+)$`);
  let maxSuffix = 0;
  for (const row of rows) {
    const candidate = String(row?.id || '').trim();
    const match = matcher.exec(candidate);
    if (!match) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > maxSuffix) {
      maxSuffix = parsed;
    }
  }

  const exists = db.prepare<{ id: string }>(`SELECT id FROM ${tableName} WHERE id = ?`);
  let next = maxSuffix + 1;
  while (true) {
    const id = `${normalizedPrefix}-${String(next).padStart(3, '0')}`;
    if (!exists.get(id)) {
      return id;
    }
    next += 1;
  }
}

export function appendInventoryMovement(payload: InventoryMovementPayload) {
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, warehouse_id, movement_type, source_type, source_id,
      qty_change, reserved_change, qty_before, qty_after, reserved_before, reserved_after,
      occurred_at, operator_id, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.productId,
    payload.warehouseId,
    payload.movementType,
    payload.sourceType,
    payload.sourceId,
    payload.qtyChange,
    payload.reservedChange,
    payload.qtyBefore,
    payload.qtyAfter,
    payload.reservedBefore,
    payload.reservedAfter,
    payload.occurredAt || new Date().toISOString(),
    payload.operatorId || null,
    payload.remark || null,
  );
}

function ensureDeliveryNotes() {
  const missingOrders = db.prepare<MissingDeliveryOrderRow>(`
    SELECT
      so.id,
      so.order_date as orderDate,
      so.order_channel as orderChannel,
      so.status
    FROM sales_orders so
    LEFT JOIN delivery_notes dn ON dn.sales_order_id = so.id
    WHERE dn.id IS NULL
      AND so.status <> '已取消'
    ORDER BY so.order_date ASC, so.id ASC
  `).all();

  if (missingOrders.length === 0) {
    return;
  }

  const insertDelivery = db.prepare(
    `INSERT INTO delivery_notes (
      id, sales_order_id, created_at, shipment_status, courier, tracking_no, shipped_at, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const transaction = db.transaction(() => {
    missingOrders.forEach((order) => {
      const delivered = order.status === '已发货' || order.status === '已完成';
      const deliveryId = nextDocumentId('delivery_notes', 'SHP', order.orderDate);
      insertDelivery.run(
        deliveryId,
        order.id,
        order.orderDate,
        delivered ? '已发货' : '待发货',
        delivered ? inferCourier(order.orderChannel) : null,
        delivered ? buildTrackingNumber(deliveryId) : null,
        delivered ? order.orderDate : null,
        delivered ? '系统初始化同步历史发货记录。' : null
      );
    });
  });

  transaction();
}

export function createReceivableForSalesOrder(salesOrderId: string, options?: CreateReceivableOptions) {
  const existing = db.prepare<{ id: string }>('SELECT id FROM receivables WHERE sales_order_id = ?').get(salesOrderId);
  if (existing?.id) {
    return existing.id;
  }

  const order = db.prepare<{
    id: string;
    orderDate: string;
    expectedDeliveryDate: string;
    status: string;
    totalAmount: number;
  }>(`
    SELECT
      id,
      order_date as orderDate,
      expected_delivery_date as expectedDeliveryDate,
      status,
      total_amount as totalAmount
    FROM sales_orders
    WHERE id = ?
  `).get(salesOrderId);
  if (!order) {
    throw new Error('Sales order not found');
  }
  if (order.status === '已取消') {
    throw new Error('Cancelled sales order cannot create receivable');
  }

  const receivableId = nextDocumentId('receivables', 'AR', order.orderDate);
  const dueDate = addDays(order.expectedDeliveryDate, 7);
  const seedByStatus = Boolean(options?.seedByStatus);
  const amountPaid =
    seedByStatus && order.status === '已完成'
      ? order.totalAmount
      : seedByStatus && order.status === '已发货'
        ? roundCurrency(order.totalAmount * 0.6)
        : 0;
  const lastReceivedAt = amountPaid > 0 ? addDays(order.orderDate, 1) : null;

  db.prepare(`
    INSERT INTO receivables (
      id, sales_order_id, amount_due, amount_paid, due_date, last_received_at, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    receivableId,
    salesOrderId,
    order.totalAmount,
    amountPaid,
    dueDate,
    lastReceivedAt,
    options?.remark ?? (seedByStatus ? '系统初始化同步历史应收记录。' : '订单创建后自动生成应收记录。'),
  );

  if (amountPaid > 0 && lastReceivedAt) {
    db.prepare(
      'INSERT INTO receipt_records (id, receivable_id, amount, received_at, method, remark) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      `${receivableId}-REC-001`,
      receivableId,
      amountPaid,
      lastReceivedAt,
      '银行转账',
      '系统初始化补录历史收款。',
    );
  }

  return receivableId;
}

export function createPayableForPurchaseOrder(purchaseOrderId: string, options?: CreatePayableOptions) {
  const existing = db.prepare<{ id: string }>('SELECT id FROM payables WHERE purchase_order_id = ?').get(purchaseOrderId);
  if (existing?.id) {
    return existing.id;
  }

  const order = db.prepare<{
    id: string;
    createdAt: string;
    expectedAt: string;
    status: string;
    amount: number;
  }>(`
    SELECT
      po.id,
      po.created_at as createdAt,
      po.expected_at as expectedAt,
      po.status,
      COALESCE(SUM(poi.ordered_qty * poi.unit_cost), 0) as amount
    FROM purchase_orders po
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    WHERE po.id = ?
    GROUP BY po.id, po.created_at, po.expected_at, po.status
  `).get(purchaseOrderId);
  if (!order) {
    throw new Error('Purchase order not found');
  }
  if (order.status === '已取消') {
    throw new Error('Cancelled purchase order cannot create payable');
  }

  const payableId = nextDocumentId('payables', 'AP', order.createdAt);
  const dueDate = addDays(order.expectedAt, 5);
  const seedByStatus = Boolean(options?.seedByStatus);
  const amountPaid =
    seedByStatus && order.status === '已完成'
      ? order.amount
      : seedByStatus && order.status === '部分到货'
        ? roundCurrency(order.amount * 0.5)
        : 0;
  const lastPaidAt = amountPaid > 0 ? addDays(order.createdAt, 2) : null;

  db.prepare(`
    INSERT INTO payables (
      id, purchase_order_id, amount_due, amount_paid, due_date, last_paid_at, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    payableId,
    purchaseOrderId,
    order.amount,
    amountPaid,
    dueDate,
    lastPaidAt,
    options?.remark ?? (seedByStatus ? '系统初始化同步历史应付记录。' : '采购单创建后自动生成应付记录。'),
  );

  if (amountPaid > 0 && lastPaidAt) {
    db.prepare(
      'INSERT INTO payment_records (id, payable_id, amount, paid_at, method, remark) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      `${payableId}-PAY-001`,
      payableId,
      amountPaid,
      lastPaidAt,
      '对公转账',
      '系统初始化补录历史付款。',
    );
  }

  return payableId;
}

export function ensureFinanceDocuments(): FinanceSyncResult {
  const missingReceivables = db.prepare<MissingReceivableRow>(`
    SELECT
      so.id,
      so.order_date as orderDate,
      so.expected_delivery_date as expectedDeliveryDate,
      so.status,
      so.total_amount as totalAmount
    FROM sales_orders so
    LEFT JOIN receivables r ON r.sales_order_id = so.id
    WHERE r.id IS NULL
      AND so.status <> '已取消'
    ORDER BY so.order_date ASC, so.id ASC
  `).all();

  const missingPayables = db.prepare<MissingPayableRow>(`
    SELECT
      po.id,
      po.created_at as createdAt,
      po.expected_at as expectedAt,
      po.status,
      COALESCE(SUM(poi.ordered_qty * poi.unit_cost), 0) as amount
    FROM purchase_orders po
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    LEFT JOIN payables p ON p.purchase_order_id = po.id
    WHERE p.id IS NULL
    GROUP BY po.id, po.created_at, po.expected_at, po.status
    ORDER BY po.created_at ASC, po.id ASC
  `).all();

  if (missingReceivables.length === 0 && missingPayables.length === 0) {
    return {
      receivablesCreated: 0,
      payablesCreated: 0,
    };
  }

  const transaction = db.transaction(() => {
    let receivablesCreated = 0;
    let payablesCreated = 0;

    missingReceivables.forEach((order) => {
      createReceivableForSalesOrder(
        order.id,
        { seedByStatus: true, remark: '系统初始化同步历史应收记录。' },
      );
      receivablesCreated += 1;
    });

    missingPayables.forEach((order) => {
      createPayableForPurchaseOrder(
        order.id,
        { seedByStatus: true, remark: '系统初始化同步历史应付记录。' },
      );
      payablesCreated += 1;
    });

    return {
      receivablesCreated,
      payablesCreated,
    };
  });

  return transaction();
}

export function syncFinanceDocuments() {
  return ensureFinanceDocuments();
}

interface PermissionSeedDefinition {
  id: string;
  code: string;
  label: string;
  moduleId: string;
}

const CORE_PERMISSION_DEFINITIONS: PermissionSeedDefinition[] = [
  { id: 'PERM-001', code: 'orders.view', label: '查看订单', moduleId: 'orders' },
  { id: 'PERM-002', code: 'orders.create', label: '创建订单', moduleId: 'orders' },
  { id: 'PERM-003', code: 'inventory.view', label: '查看库存', moduleId: 'inventory' },
  { id: 'PERM-004', code: 'procurement.manage', label: '采购管理', moduleId: 'procurement' },
  { id: 'PERM-005', code: 'shipping.dispatch', label: '确认发货', moduleId: 'shipping' },
  { id: 'PERM-006', code: 'finance.receivable', label: '应收收款登记', moduleId: 'finance' },
  { id: 'PERM-007', code: 'finance.payable', label: '应付付款登记', moduleId: 'finance' },
  { id: 'PERM-008', code: 'reports.view', label: '查看经营报表', moduleId: 'reports' },
  { id: 'PERM-009', code: 'settings.master-data', label: '维护基础资料', moduleId: 'settings' },
  { id: 'PERM-010', code: 'settings.access-control', label: '维护角色权限', moduleId: 'settings' },
  { id: 'PERM-011', code: 'inventory.write', label: '库存写操作', moduleId: 'inventory' },
  { id: 'PERM-012', code: 'finance.view', label: '查看财务', moduleId: 'finance' },
];

const ROLE_PERMISSION_DEFAULTS: Record<string, string[]> = {
  'ROLE-001': [
    'orders.view',
    'orders.create',
    'inventory.view',
    'inventory.write',
    'procurement.manage',
    'shipping.dispatch',
    'finance.view',
    'finance.receivable',
    'finance.payable',
    'reports.view',
    'settings.master-data',
    'settings.access-control',
  ],
  'ROLE-002': ['finance.view', 'finance.receivable', 'finance.payable', 'reports.view'],
  'ROLE-003': ['inventory.view', 'inventory.write', 'shipping.dispatch'],
  'ROLE-004': ['procurement.manage', 'settings.master-data'],
  'ROLE-005': ['orders.view', 'orders.create', 'reports.view', 'finance.view'],
};

const LEGACY_PERMISSION_ALIAS_MAP: Array<[string, string]> = [
  ['orders.read', 'orders.view'],
  ['inventory.read', 'inventory.view'],
  ['reports.read', 'reports.view'],
  ['finance.read', 'finance.view'],
  ['customers.read', 'settings.master-data'],
  ['customers.manage', 'settings.master-data'],
];

function findPermissionSeed(code: string) {
  return CORE_PERMISSION_DEFINITIONS.find((item) => item.code === code);
}

function mergeLegacyPermissionCode(fromCode: string, toCode: string) {
  const from = db.prepare<{ id: string }>('SELECT id FROM permissions WHERE code = ?').get(fromCode);
  if (!from) {
    return;
  }

  const to = db.prepare<{ id: string }>('SELECT id FROM permissions WHERE code = ?').get(toCode);
  if (!to) {
    const seed = findPermissionSeed(toCode);
    db.prepare('UPDATE permissions SET code = ?, label = COALESCE(?, label), module_id = COALESCE(?, module_id) WHERE id = ?').run(
      toCode,
      seed?.label ?? null,
      seed?.moduleId ?? null,
      from.id,
    );
    return;
  }

  db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT role_id, ? FROM role_permissions WHERE permission_id = ?',
  ).run(to.id, from.id);
  db.prepare('DELETE FROM role_permissions WHERE permission_id = ?').run(from.id);
  db.prepare('DELETE FROM permissions WHERE id = ?').run(from.id);
}

function ensureCorePermissionCatalog() {
  LEGACY_PERMISSION_ALIAS_MAP.forEach(([from, to]) => mergeLegacyPermissionCode(from, to));

  const insertPermission = db.prepare(
    'INSERT OR IGNORE INTO permissions (id, code, label, module_id) VALUES (?, ?, ?, ?)'
  );
  const updatePermission = db.prepare('UPDATE permissions SET label = ?, module_id = ? WHERE code = ?');

  CORE_PERMISSION_DEFINITIONS.forEach((item) => {
    const existing = db.prepare<{ id: string }>('SELECT id FROM permissions WHERE code = ?').get(item.code);
    if (!existing) {
      const idConflict = db.prepare<{ id: string }>('SELECT id FROM permissions WHERE id = ?').get(item.id);
      const nextPermissionId = idConflict ? nextMasterDataId('permissions', 'PERM') : item.id;
      insertPermission.run(nextPermissionId, item.code, item.label, item.moduleId);
    } else {
      updatePermission.run(item.label, item.moduleId, item.code);
    }
  });

  const permissionRows = db.prepare<{ id: string; code: string }>('SELECT id, code FROM permissions').all();
  const permissionIdByCode = new Map(permissionRows.map((item) => [item.code, item.id]));
  const insertRolePermission = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
  );

  Object.entries(ROLE_PERMISSION_DEFAULTS).forEach(([roleId, permissionCodes]) => {
    permissionCodes.forEach((permissionCode) => {
      const permissionId = permissionIdByCode.get(permissionCode);
      if (!permissionId) {
        return;
      }
      insertRolePermission.run(roleId, permissionId);
    });
  });
}

export function ensureAccessControlData() {
  const roleCount = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM roles').get()?.count ?? 0;
  const permissionCount = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM permissions').get()?.count ?? 0;
  const userCount = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM users').get()?.count ?? 0;
  const rolePermissionCount = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM role_permissions').get()?.count ?? 0;
  const userRoleCount = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM user_roles').get()?.count ?? 0;
  const credentialCount = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM user_credentials').get()?.count ?? 0;

  if (
    roleCount > 0 &&
    permissionCount > 0 &&
    userCount > 0 &&
    rolePermissionCount > 0 &&
    userRoleCount > 0 &&
    credentialCount > 0
  ) {
    ensureCorePermissionCatalog();
    return;
  }

  const transaction = db.transaction(() => {
    const insertRole = db.prepare('INSERT OR IGNORE INTO roles (id, name, description, scope) VALUES (?, ?, ?, ?)');
    const insertPermission = db.prepare(
      'INSERT OR IGNORE INTO permissions (id, code, label, module_id) VALUES (?, ?, ?, ?)'
    );
    const insertRolePermission = db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
    );
    const insertUser = db.prepare(
      'INSERT OR IGNORE INTO users (id, username, email, phone, department, status) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
    const insertCredential = db.prepare(
      'INSERT OR IGNORE INTO user_credentials (user_id, password, password_updated_at, must_change_password, temporary_password_issued_at) VALUES (?, ?, ?, ?, ?)'
    );

    [
      ['ROLE-001', '系统管理员', '负责全模块配置、审批和系统维护。', 'global'],
      ['ROLE-002', '财务专员', '负责应收、应付、收付款和对账。', 'finance'],
      ['ROLE-003', '仓储主管', '负责库存、入库、发货与预警处理。', 'warehouse'],
      ['ROLE-004', '采购专员', '负责采购、到货和供应商协同。', 'procurement'],
      ['ROLE-005', '运营经理', '负责订单、履约进度和经营报表。', 'operations'],
    ].forEach((row) => insertRole.run(...row));

    CORE_PERMISSION_DEFINITIONS.forEach((row) => insertPermission.run(row.id, row.code, row.label, row.moduleId));

    const permissionRows = db.prepare<{ id: string; code: string }>('SELECT id, code FROM permissions').all();
    const permissionIdByCode = new Map(permissionRows.map((item) => [item.code, item.id]));
    Object.entries(ROLE_PERMISSION_DEFAULTS).forEach(([roleId, permissionCodes]) => {
      permissionCodes.forEach((permissionCode) => {
        const permissionId = permissionIdByCode.get(permissionCode);
        if (!permissionId) {
          return;
        }
        insertRolePermission.run(roleId, permissionId);
      });
    });

    const seedDemoUsers = env.nodeEnv !== 'production';
    const seededUsers: Array<[string, string, string, string, string, string]> = [
      ['USR-001', 'admin', 'admin@retail-smart-hub.com', '13800138000', '管理部', 'active'],
    ];
    const seededUserRoles: Array<[string, string]> = [['USR-001', 'ROLE-001']];

    // Demo identities are useful for local development/testing, but should not be part of production defaults.
    if (seedDemoUsers) {
      seededUsers.push(
        ['USR-002', 'finance.li', 'finance@retail-smart-hub.com', '13800138001', '财务部', 'active'],
        ['USR-003', 'warehouse.zhang', 'warehouse@retail-smart-hub.com', '13800138002', '仓储部', 'active'],
        ['USR-004', 'buyer.wang', 'buyer@retail-smart-hub.com', '13800138003', '采购部', 'active'],
        ['USR-005', 'ops.chen', 'ops@retail-smart-hub.com', '13800138004', '运营部', 'inactive'],
      );
      seededUserRoles.push(['USR-002', 'ROLE-002'], ['USR-003', 'ROLE-003'], ['USR-004', 'ROLE-004'], ['USR-005', 'ROLE-005']);
    }

    seededUsers.forEach((row) => insertUser.run(...row));
    seededUserRoles.forEach((row) => insertUserRole.run(...row));

    const seededPasswordUpdatedAt = `${currentDateString()}T00:00:00.000Z`;
    // Bootstrap admin password:
    // - never a hardcoded constant
    // - one-time/random on first install (when seeding happens)
    // - mustChangePassword enforced on first login
    const configuredBootstrapAdminPassword = process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD?.trim() || '';
    const bootstrapAdminPassword = configuredBootstrapAdminPassword || generateTemporaryPassword(18);
    const seededCredentialUsers: Array<{ userId: string; username: string; password: string; mustChangePassword: boolean }> = [
      {
        userId: 'USR-001',
        username: 'admin',
        password: bootstrapAdminPassword,
        mustChangePassword: true,
      },
    ];

    if (seedDemoUsers) {
      seededCredentialUsers.push(
        { userId: 'USR-002', username: 'finance.li', password: generateTemporaryPassword(18), mustChangePassword: true },
        { userId: 'USR-003', username: 'warehouse.zhang', password: generateTemporaryPassword(18), mustChangePassword: true },
        { userId: 'USR-004', username: 'buyer.wang', password: generateTemporaryPassword(18), mustChangePassword: true },
        { userId: 'USR-005', username: 'ops.chen', password: generateTemporaryPassword(18), mustChangePassword: true },
      );
    }
    const seededPlaintextPasswords: Array<{ username: string; temporaryPassword: string }> = [];

    seededCredentialUsers.forEach(({ userId, username, password, mustChangePassword }) => {
      insertCredential.run(
        userId,
        hashPassword(password),
        seededPasswordUpdatedAt,
        mustChangePassword ? 1 : 0,
        mustChangePassword ? seededPasswordUpdatedAt : null,
      );
      if (mustChangePassword) {
        seededPlaintextPasswords.push({ username, temporaryPassword: password });
      }
    });

    if (env.authDebugLogSeedPasswords && seededPlaintextPasswords.length > 0) {
      console.warn('[auth-bootstrap] seeded users have one-time temporary passwords:');
      seededPlaintextPasswords.forEach((item) => {
        console.warn(`[auth-bootstrap] ${item.username}: ${item.temporaryPassword}`);
      });
    }

    // Ensure first-run operator can access the system without shipping a default password.
    // If AUTH_BOOTSTRAP_ADMIN_PASSWORD is set, the operator already knows it; otherwise we log the generated one-time password once.
    if (!configuredBootstrapAdminPassword && credentialCount === 0) {
      persistBootstrapAdminPassword(bootstrapAdminPassword);
      console.warn(`[auth-bootstrap] admin one-time temporary password: ${bootstrapAdminPassword}`);
      console.warn('[auth-bootstrap] please login as admin and change the password immediately.');
      console.warn(`[auth-bootstrap] bootstrap password file: ${bootstrapAdminPasswordPath}`);
    }
  });

  transaction();
  ensureCorePermissionCatalog();
}

export function ensureCustomerProfiles() {
  const aggregates = db.prepare<CustomerAggregateRow>(`
    SELECT
      so.customer_name as name,
      MAX(so.order_channel) as orderChannel,
      MAX(so.order_date) as lastOrderDate,
      SUM(CASE WHEN so.status <> '已取消' THEN 1 ELSE 0 END) as totalOrders,
      COALESCE(SUM(CASE WHEN so.status <> '已取消' THEN so.total_amount ELSE 0 END), 0) as totalSales
    FROM sales_orders so
    GROUP BY so.customer_name
    ORDER BY so.customer_name ASC
  `).all();

  if (aggregates.length === 0) {
    return;
  }

  const findCustomer = db.prepare<{ id: string }>('SELECT id FROM customers WHERE name = ?');
  const insertCustomer = db.prepare(
    `INSERT INTO customers (
      id, name, channel_preference, contact_name, phone, level, last_order_date, total_orders, total_sales, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateCustomer = db.prepare(
    `UPDATE customers
      SET channel_preference = ?, last_order_date = ?, total_orders = ?, total_sales = ?, level = ?
      WHERE id = ?`
  );

  const transaction = db.transaction(() => {
    aggregates.forEach((customer) => {
      const existing = findCustomer.get(customer.name);
      if (!existing) {
        insertCustomer.run(
          nextMasterDataId('customers', 'CUS'),
          customer.name,
          customer.orderChannel,
          null,
          null,
          customer.totalSales >= 20000 ? 'A' : customer.totalSales >= 5000 ? 'B' : 'C',
          customer.lastOrderDate,
          customer.totalOrders,
          customer.totalSales,
          'active'
        );
        return;
      }

      updateCustomer.run(
        customer.orderChannel,
        customer.lastOrderDate,
        customer.totalOrders,
        customer.totalSales,
        customer.totalSales >= 20000 ? 'A' : customer.totalSales >= 5000 ? 'B' : 'C',
        existing.id
      );
    });
  });

  transaction();
}

export function upsertCustomerProfile(customerName: string, orderChannel: string, orderDate: string, orderAmount = 0) {
  const existing = db.prepare<{ id: string; totalOrders: number; totalSales: number; status: string }>(
    'SELECT id, total_orders as totalOrders, total_sales as totalSales, status FROM customers WHERE name = ?'
  ).get(customerName);

  if (!existing) {
    db.prepare(
      `INSERT INTO customers (
        id, name, channel_preference, contact_name, phone, level, last_order_date, total_orders, total_sales, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nextMasterDataId('customers', 'CUS'),
      customerName,
      orderChannel,
      null,
      null,
      orderAmount >= 20000 ? 'A' : orderAmount >= 5000 ? 'B' : 'C',
      orderDate,
      1,
      orderAmount,
      'active'
    );
    return;
  }

  const totalOrders = existing.totalOrders + 1;
  const totalSales = existing.totalSales + orderAmount;

  db.prepare(
    `UPDATE customers
      SET channel_preference = ?, last_order_date = ?, total_orders = ?, total_sales = ?, level = ?, status = ?
      WHERE id = ?`
  ).run(
    orderChannel,
    orderDate,
    totalOrders,
    totalSales,
    totalSales >= 20000 ? 'A' : totalSales >= 5000 ? 'B' : 'C',
    existing.status === 'deleted' ? 'active' : existing.status,
    existing.id
  );
}

export function nextDocumentId(tableName: string, prefix: string, dateString = currentDateString()) {
  const datePart = compactDate(dateString);
  const like = `${prefix}-${datePart}-%`;
  const sql = `SELECT COUNT(*) as count FROM ${tableName} WHERE id LIKE ?`;
  const count = db.prepare<{ count: number }>(sql).get(like)?.count ?? 0;
  return `${prefix}-${datePart}-${String(count + 1).padStart(3, '0')}`;
}

export function appendAuditLog(action: string, entityType: string, entityId: string, payload: unknown) {
  db.prepare(
    'INSERT INTO audit_logs (action, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(action, entityType, entityId, JSON.stringify(payload ?? null), new Date().toISOString());
}

initializeDatabase();







