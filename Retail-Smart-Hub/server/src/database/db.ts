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

  // 统一封装 SQLite 语句结果，避免上层直接依赖底层驱动对象。
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

  // 这里直接暴露 exec，供建表、迁移和初始化脚本使用。
  exec(sql: string) {
    this.database.exec(sql);
  }

  // 只允许调用方传入 PRAGMA 片段，减少散落的数据库配置代码。
  pragma(statement: string) {
    this.database.exec(`PRAGMA ${statement}`);
  }

  prepare<T = unknown>(sql: string) {
    return new StatementWrapper<T>(this.database.prepare(sql));
  }

  // 使用 SAVEPOINT 包裹事务，便于在同一连接里支持嵌套写操作。
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
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';

fs.mkdirSync(databaseDir, { recursive: true });

export const db = new DatabaseWrapper(databasePath);
// WAL 提升并发读写稳定性，foreign_keys 确保外键约束始终生效。
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function repairDefaultAdminCredentials() {
  const adminRow = db.prepare<{ id: string }>('SELECT id FROM users WHERE username = ?').get(DEFAULT_ADMIN_USERNAME);
  if (!adminRow) {
    return;
  }

  const passwordUpdatedAt = `${currentDateString()}T00:00:00.000Z`;
  const passwordHash = hashPassword(DEFAULT_ADMIN_PASSWORD);

  db.prepare(`
    INSERT INTO user_credentials (
      user_id, password, password_updated_at, must_change_password, temporary_password_issued_at
    ) VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      password = excluded.password,
      password_updated_at = excluded.password_updated_at,
      must_change_password = 0,
      temporary_password_issued_at = NULL
  `).run(adminRow.id, passwordHash, passwordUpdatedAt);

  db.prepare(`
    INSERT INTO auth_security_state (
      user_id, failed_attempt_count, last_failed_at, locked_until, password_updated_at
    ) VALUES (?, 0, NULL, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      failed_attempt_count = 0,
      last_failed_at = NULL,
      locked_until = NULL,
    password_updated_at = excluded.password_updated_at
  `).run(adminRow.id, passwordUpdatedAt);
}

function clearAllSecurityLocks() {
  db.prepare(`
    UPDATE auth_security_state
      SET failed_attempt_count = 0,
          last_failed_at = NULL,
          locked_until = NULL
  `).run();
}

// 首次启动时会把管理员临时密码写入本地文件，方便首次登录后立刻改密。

function initializeDatabase() {
  // 所有核心表结构、补丁迁移和演示数据入口都从这里串起来。
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

    CREATE TABLE IF NOT EXISTS warehouse_shelves (
      id TEXT PRIMARY KEY,
      warehouse_id TEXT NOT NULL,
      shelf_code TEXT NOT NULL,
      shelf_name TEXT NOT NULL,
      tags TEXT,
      capacity INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      UNIQUE (warehouse_id, shelf_code)
    );

    CREATE TABLE IF NOT EXISTS inventory_shelf_stock (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      shelf_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (shelf_id) REFERENCES warehouse_shelves(id),
      UNIQUE (product_id, warehouse_id, shelf_id)
    );

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

    CREATE TABLE IF NOT EXISTS shipment_documents (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      shipment_status TEXT NOT NULL,
      document_scope TEXT NOT NULL,
      courier TEXT,
      tracking_no TEXT,
      shipped_at TEXT,
      remark TEXT
    );

    CREATE TABLE IF NOT EXISTS shipment_document_orders (
      id TEXT PRIMARY KEY,
      shipment_document_id TEXT NOT NULL,
      sales_order_id TEXT NOT NULL,
      FOREIGN KEY (shipment_document_id) REFERENCES shipment_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
      UNIQUE (shipment_document_id, sales_order_id)
    );

    CREATE TABLE IF NOT EXISTS shipment_document_items (
      id TEXT PRIMARY KEY,
      shipment_document_id TEXT NOT NULL,
      sales_order_id TEXT NOT NULL,
      sales_order_item_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY (shipment_document_id) REFERENCES shipment_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (sales_order_item_id) REFERENCES sales_order_items(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
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

    CREATE TABLE IF NOT EXISTS receipt_record_items (
      id TEXT PRIMARY KEY,
      receipt_record_id TEXT NOT NULL,
      sales_order_item_id TEXT NOT NULL,
      product_id TEXT,
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (receipt_record_id) REFERENCES receipt_records(id) ON DELETE CASCADE,
      FOREIGN KEY (sales_order_item_id) REFERENCES sales_order_items(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
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
      customer_type TEXT NOT NULL DEFAULT 'reseller',
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

    CREATE TABLE IF NOT EXISTS ai_interruption_checkpoints (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      kind TEXT NOT NULL DEFAULT 'clarification',
      status TEXT NOT NULL DEFAULT 'awaiting_user',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      options_json TEXT NOT NULL,
      request_prompt TEXT NOT NULL,
      request_attachments_json TEXT NOT NULL DEFAULT '[]',
      request_history_json TEXT NOT NULL DEFAULT '[]',
      assistant_reply TEXT NOT NULL,
      assistant_tool_calls_json TEXT NOT NULL DEFAULT '[]',
      assistant_pending_action_json TEXT,
      parent_interruption_id TEXT,
      resume_option_id TEXT,
      resume_prompt TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resumed_at TEXT,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ai_interruption_checkpoints_conversation_status
      ON ai_interruption_checkpoints(conversation_id, user_id, status, created_at DESC);
  `);

  ensureMasterDataStatusColumns();
  ensureInboundShelfSchema();
  ensureAuthSecuritySchema();
  ensureAiPendingActionSchema();
  ensureSalesOrderTimeSchema();
  ensureSalesOrderBusinessSchema();
  ensureReceiptRecordItemData();

  const existingProducts = getTableCount(db, 'products');
  if (existingProducts > 0) {
    ensureSalesOrderTimeSchema();
    ensureSalesOrderBusinessSchema();
    ensureDeliveryNotes();
    ensureWarehouseShelfData();
    ensureAccessControlData();
    ensureAuthSecurityData();
    ensureCustomerProfiles();
    ensureReceiptRecordItemData();
    ensureDemoBusinessData();
    return;
  }

  seedBootstrapData(db);
  ensureSalesOrderTimeSchema();
  ensureSalesOrderBusinessSchema();
  ensureDeliveryNotes();
  ensureFinanceDocuments();
  ensureWarehouseShelfData();
  ensureAccessControlData();
  ensureAuthSecurityData();
  ensureCustomerProfiles();
  ensureReceiptRecordItemData();
  ensureDemoBusinessData();
}

function ensureColumnExists(tableName: string, columnName: string, definition: string) {
  ensureColumnExistsInSchema(db, tableName, columnName, definition);
}

function ensureMasterDataStatusColumns() {
  ensureColumnExists('products', 'status', "status TEXT NOT NULL DEFAULT 'active'");
  ensureColumnExists('customers', 'customer_type', "customer_type TEXT NOT NULL DEFAULT 'reseller'");
  db.exec("UPDATE products SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
  db.exec("UPDATE suppliers SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
  db.exec("UPDATE customers SET customer_type = 'reseller' WHERE customer_type IS NULL OR TRIM(customer_type) = ''");
}

function ensureInboundShelfSchema() {
  ensureColumnExists('receiving_note_items', 'inbound_qty', 'inbound_qty INTEGER NOT NULL DEFAULT 0');
  ensureColumnExists('receiving_note_items', 'shelf_id', 'shelf_id TEXT');
  // 旧数据默认把“入库数量”补成已验收数量，避免草稿为 0 导致流程卡住。
  db.exec(`
    UPDATE receiving_note_items
    SET inbound_qty = qualified_qty
    WHERE inbound_qty IS NULL OR (inbound_qty = 0 AND qualified_qty > 0)
  `);
}

function ensureWarehouseShelfData() {
  // 货架属于基础仓储数据，先补齐货架，再按现有库存自动分配默认库位。
  const insertShelf = db.prepare(
    'INSERT OR IGNORE INTO warehouse_shelves (id, warehouse_id, shelf_code, shelf_name, tags, capacity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  [
    ['SHELF-WH-001-A01', 'WH-001', 'A01', '纸品主货架', '纸品,家庭清洁,高频', 420, 10],
    ['SHELF-WH-001-A02', 'WH-001', 'A02', '洗护主货架', '洗护,日化,清洁', 360, 20],
    ['SHELF-WH-001-A03', 'WH-001', 'A03', '食品饮料货架', '饮料,食品,快消', 520, 30],
    ['SHELF-WH-001-A04', 'WH-001', 'A04', '综合补货货架', '综合,补货,整箱', 460, 40],
    ['SHELF-WH-002-B01', 'WH-002', 'B01', '周转待发货架', '周转,待发货,电商', 320, 10],
    ['SHELF-WH-002-B02', 'WH-002', 'B02', '饮料周转货架', '饮料,快消,周转', 380, 20],
    ['SHELF-WH-002-B03', 'WH-002', 'B03', '纸品大件货架', '纸品,大件,周转', 340, 30],
  ].forEach((row) => insertShelf.run(...row));

  db.exec(`
    UPDATE warehouse_shelves
    SET capacity = capacity * 10
    WHERE capacity > 0 AND capacity < 1000
  `);

  const inventoryRows = db.prepare<{
    productId: string;
    warehouseId: string;
    quantity: number;
    productName: string;
    category: string;
  }>(`
    SELECT
      i.product_id as productId,
      i.warehouse_id as warehouseId,
      i.current_stock as quantity,
      p.name as productName,
      p.category as category
    FROM inventory i
    JOIN products p ON p.id = i.product_id
    LEFT JOIN inventory_shelf_stock iss
      ON iss.product_id = i.product_id
      AND iss.warehouse_id = i.warehouse_id
    WHERE i.current_stock > 0
      AND iss.id IS NULL
    ORDER BY p.sku ASC
  `).all();

  if (inventoryRows.length === 0) {
    return;
  }

  const shelfByWarehouse = new Map<string, string[]>([
    ['WH-001', ['SHELF-WH-001-A01', 'SHELF-WH-001-A02', 'SHELF-WH-001-A03', 'SHELF-WH-001-A04']],
    ['WH-002', ['SHELF-WH-002-B01', 'SHELF-WH-002-B02', 'SHELF-WH-002-B03']],
  ]);

  const pickShelfId = (productName: string, category: string, warehouseId: string) => {
    const normalized = `${productName} ${category}`;
    const candidates = shelfByWarehouse.get(warehouseId) || shelfByWarehouse.get('WH-001') || [];
    if (normalized.includes('纸')) {
      return candidates.find((item) => item.endsWith('A01') || item.endsWith('B03')) || candidates[0];
    }
    if (normalized.includes('洗') || normalized.includes('清') || normalized.includes('护')) {
      return candidates.find((item) => item.endsWith('A02')) || candidates[0];
    }
    if (normalized.includes('饮') || normalized.includes('食') || normalized.includes('零')) {
      return candidates.find((item) => item.endsWith('A03') || item.endsWith('B02')) || candidates[0];
    }
    return candidates[candidates.length - 1] || 'SHELF-WH-001-A04';
  };

  const insertShelfStock = db.prepare(
    'INSERT OR IGNORE INTO inventory_shelf_stock (id, product_id, warehouse_id, shelf_id, quantity) VALUES (?, ?, ?, ?, ?)',
  );

  inventoryRows.forEach((row) => {
    const shelfId = pickShelfId(row.productName, row.category, row.warehouseId);
    insertShelfStock.run(
      nextDocumentId('inventory_shelf_stock', 'SLT'),
      row.productId,
      row.warehouseId,
      shelfId,
      row.quantity,
    );
  });
}

function ensureAuthSecuritySchema() {
  // 认证安全相关表结构由独立迁移维护，这里只触发执行。
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
  // 早期订单可能只有 order_date，这里补成可追踪的创建时间。
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
  // 销售单业务字段的兼容迁移集中放到专门的迁移脚本里。
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

  // 不用 COUNT(*) + 1，避免删除记录后重复复用旧编号。
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
  // 历史销售单如果缺少发货单，这里按当前订单状态补齐。
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
  // 每张销售单只生成一条应收记录，避免重复插入。
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
  // 每张采购单只生成一条应付记录，历史数据也通过这里补齐。
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
      : seedByStatus && (order.status === '到货' || order.status === '部分到货')
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

interface ReceiptSeedRow {
  id: string;
  receivableId: string;
  amount: number;
}

interface ReceiptSeedItemRow {
  receiptRecordId: string;
  salesOrderItemId: string;
  amount: number;
}

interface ReceivableSeedLineRow {
  receivableId: string;
  salesOrderItemId: string;
  productId: string | null;
  sku: string;
  productName: string;
  lineAmount: number;
}

function ensureReceiptRecordItemData() {
  // 旧版本收款记录没有商品行明细，这里按订单行回填成可打印结构。
  const missingReceiptCount =
    db.prepare<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM receipt_records rr
      LEFT JOIN receipt_record_items rri ON rri.receipt_record_id = rr.id
      WHERE rri.id IS NULL
    `).get()?.count ?? 0;

  if (missingReceiptCount <= 0) {
    return;
  }

  const receipts = db.prepare<ReceiptSeedRow>(`
    SELECT
      id,
      receivable_id as receivableId,
      amount
    FROM receipt_records
    ORDER BY receivable_id ASC, received_at ASC, id ASC
  `).all();

  const existingItems = db.prepare<ReceiptSeedItemRow>(`
    SELECT
      receipt_record_id as receiptRecordId,
      sales_order_item_id as salesOrderItemId,
      amount
    FROM receipt_record_items
  `).all();

  const lineRows = db.prepare<ReceivableSeedLineRow>(`
    SELECT
      r.id as receivableId,
      soi.id as salesOrderItemId,
      soi.product_id as productId,
      soi.sku,
      soi.product_name as productName,
      ROUND(soi.quantity * soi.unit_price, 2) as lineAmount
    FROM receivables r
    JOIN sales_orders so ON so.id = r.sales_order_id
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    ORDER BY r.id ASC, soi.id ASC
  `).all();

  const receiptsByReceivableId = new Map<string, ReceiptSeedRow[]>();
  receipts.forEach((receipt) => {
    const list = receiptsByReceivableId.get(receipt.receivableId) || [];
    list.push(receipt);
    receiptsByReceivableId.set(receipt.receivableId, list);
  });

  const existingItemsByReceiptId = new Map<string, ReceiptSeedItemRow[]>();
  existingItems.forEach((item) => {
    const list = existingItemsByReceiptId.get(item.receiptRecordId) || [];
    list.push(item);
    existingItemsByReceiptId.set(item.receiptRecordId, list);
  });

  const linesByReceivableId = new Map<string, ReceivableSeedLineRow[]>();
  lineRows.forEach((item) => {
    const list = linesByReceivableId.get(item.receivableId) || [];
    list.push(item);
    linesByReceivableId.set(item.receivableId, list);
  });

  const insertReceiptItem = db.prepare(
    `INSERT OR IGNORE INTO receipt_record_items (
      id, receipt_record_id, sales_order_item_id, product_id, sku, product_name, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const transaction = db.transaction(() => {
    receiptsByReceivableId.forEach((receivableReceipts, receivableId) => {
      const lines = (linesByReceivableId.get(receivableId) || []).map((line) => ({
        ...line,
        remainingCents: Math.round(line.lineAmount * 100),
      }));
      const lineMap = new Map(lines.map((line) => [line.salesOrderItemId, line]));

      receivableReceipts.forEach((receipt) => {
        const currentItems = existingItemsByReceiptId.get(receipt.id) || [];
        if (currentItems.length > 0) {
          currentItems.forEach((item) => {
            const line = lineMap.get(item.salesOrderItemId);
            if (!line) {
              return;
            }
            line.remainingCents = Math.max(0, line.remainingCents - Math.round(item.amount * 100));
          });
          return;
        }

        let remainingCents = Math.round(receipt.amount * 100);
        let lineIndex = 0;

        for (const line of lines) {
          if (remainingCents <= 0) {
            break;
          }
          if (line.remainingCents <= 0) {
            continue;
          }

          const allocatedCents = Math.min(line.remainingCents, remainingCents);
          if (allocatedCents <= 0) {
            continue;
          }

          lineIndex += 1;
          insertReceiptItem.run(
            `${receipt.id}-ITEM-${String(lineIndex).padStart(3, '0')}`,
            receipt.id,
            line.salesOrderItemId,
            line.productId,
            line.sku,
            line.productName,
            allocatedCents / 100,
          );

          line.remainingCents -= allocatedCents;
          remainingCents -= allocatedCents;
        }

        if (remainingCents > 0 && lines.length > 0) {
          const fallbackLine = lines[lines.length - 1];
          lineIndex += 1;
          insertReceiptItem.run(
            `${receipt.id}-ITEM-${String(lineIndex).padStart(3, '0')}`,
            receipt.id,
            fallbackLine.salesOrderItemId,
            fallbackLine.productId,
            fallbackLine.sku,
            fallbackLine.productName,
            remainingCents / 100,
          );
          fallbackLine.remainingCents = Math.max(0, fallbackLine.remainingCents - remainingCents);
        }
      });
    });
  });

  transaction();
}

function ensureDemoBusinessData() {
  const today = currentDateString();
  // 演示数据使用一个事务整体写入，避免中途失败留下半套数据。
  const transaction = db.transaction(() => {
    const insertProduct = db.prepare(
      'INSERT OR IGNORE INTO products (id, sku, name, category, unit, status, safe_stock, sale_price, cost_price, preferred_supplier_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertInventory = db.prepare(
      'INSERT OR IGNORE INTO inventory (id, product_id, warehouse_id, current_stock, reserved_stock) VALUES (?, ?, ?, ?, ?)',
    );
    const insertCustomer = db.prepare(
      'INSERT OR IGNORE INTO customers (id, name, customer_type, channel_preference, contact_name, phone, level, last_order_date, total_orders, total_sales, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertSalesOrder = db.prepare(
      'INSERT OR IGNORE INTO sales_orders (id, customer_name, order_channel, order_date, expected_delivery_date, status, stock_status, total_amount, item_count, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertSalesOrderItem = db.prepare(
      'INSERT OR IGNORE INTO sales_order_items (id, sales_order_id, product_id, sku, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertPurchaseOrder = db.prepare(
      'INSERT OR IGNORE INTO purchase_orders (id, supplier_id, created_at, expected_at, status, source, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertPurchaseOrderItem = db.prepare(
      'INSERT OR IGNORE INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, arrived_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertReceivingNote = db.prepare(
      'INSERT OR IGNORE INTO receiving_notes (id, purchase_order_id, supplier_id, expected_qty, arrived_qty, qualified_qty, defect_qty, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertReceivingNoteItem = db.prepare(
      'INSERT OR IGNORE INTO receiving_note_items (id, receiving_note_id, purchase_order_item_id, product_id, expected_qty, arrived_qty, qualified_qty, defect_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertInboundOrder = db.prepare(
      'INSERT OR IGNORE INTO inbound_orders (id, receiving_note_id, warehouse_id, inbound_qty, status, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    const productCatalog = {
      PRD_001: { id: 'PRD-001', sku: 'SKU-1001', name: '维达抽纸 24包', price: 59.9, cost: 38 },
      PRD_003: { id: 'PRD-003', sku: 'SKU-1003', name: '蓝月亮洗衣液 3kg', price: 79, cost: 48 },
      PRD_005: { id: 'PRD-005', sku: 'SKU-1005', name: '洁柔卷纸 12卷', price: 45, cost: 29 },
      PRD_006: { id: 'PRD-006', sku: 'SKU-1006', name: '奥利奥夹心饼干', price: 18, cost: 8 },
      PRD_007: { id: 'PRD-007', sku: 'SKU-1007', name: '无糖乌龙茶 500ml', price: 52, cost: 31 },
      PRD_008: { id: 'PRD-008', sku: 'SKU-1008', name: '厨房湿巾 80抽', price: 16.8, cost: 9.5 },
      PRD_009: { id: 'PRD-009', sku: 'SKU-1009', name: '晨光中性笔 24支装', price: 36, cost: 20 },
      PRD_010: { id: 'PRD-010', sku: 'SKU-1010', name: '苏打气泡水 330ml', price: 42, cost: 24 },
    } as const;

    insertProduct.run('PRD-007', 'SKU-1007', '无糖乌龙茶 500ml', '饮料饮品', '箱', 'active', 45, 52, 31, 'SUP-003');
    insertProduct.run('PRD-008', 'SKU-1008', '厨房湿巾 80抽', '家庭清洁', '包', 'active', 60, 16.8, 9.5, 'SUP-001');
    insertProduct.run('PRD-009', 'SKU-1009', '晨光中性笔 24支装', '办公用品', '盒', 'active', 35, 36, 20, 'SUP-001');
    insertProduct.run('PRD-010', 'SKU-1010', '苏打气泡水 330ml', '饮料饮品', '箱', 'active', 40, 42, 24, 'SUP-003');

    insertInventory.run('INV-007', 'PRD-007', 'WH-001', 64, 0);
    insertInventory.run('INV-008', 'PRD-008', 'WH-001', 110, 0);
    insertInventory.run('INV-009', 'PRD-009', 'WH-001', 88, 0);
    insertInventory.run('INV-010', 'PRD-010', 'WH-001', 72, 0);

    insertCustomer.run('CUS-DEMO-SUP-001', '华北联采供应协同', 'supplier', '供应协同', '邱雯', '13800139001', 'B', null, 0, 0, 'active');
    insertCustomer.run('CUS-DEMO-SUP-002', '京津办公物资供应组', 'supplier', '供应协同', '姜岚', '13800139002', 'B', null, 0, 0, 'active');

    const salesDemo = [
      {
        date: addDays(today, -6),
        sequence: '901',
        customer: '国贸白领店',
        channel: '门店补货',
        status: '已完成',
        stockStatus: '-',
        expectedOffset: 1,
        remark: '演示数据：晨间补货已完成。',
        items: [
          { ...productCatalog.PRD_005, quantity: 16, unitPrice: 45 },
          { ...productCatalog.PRD_006, quantity: 22, unitPrice: 18 },
        ],
      },
      {
        date: addDays(today, -5),
        sequence: '902',
        customer: '望京企业客户',
        channel: '企业团购',
        status: '已完成',
        stockStatus: '-',
        expectedOffset: 2,
        remark: '演示数据：月度团购整单签收。',
        items: [
          { ...productCatalog.PRD_001, quantity: 18, unitPrice: 59.9 },
          { ...productCatalog.PRD_009, quantity: 12, unitPrice: 36 },
        ],
      },
      {
        date: addDays(today, -4),
        sequence: '903',
        customer: '朝阳社区店',
        channel: '门店补货',
        status: '已发货',
        stockStatus: '-',
        expectedOffset: 1,
        remark: '演示数据：下午波次已出库。',
        items: [
          { ...productCatalog.PRD_010, quantity: 10, unitPrice: 42 },
          { ...productCatalog.PRD_008, quantity: 20, unitPrice: 16.8 },
        ],
      },
      {
        date: addDays(today, -3),
        sequence: '904',
        customer: '线上商城华北仓',
        channel: '线上商城',
        status: '已发货',
        stockStatus: '-',
        expectedOffset: 2,
        remark: '演示数据：电商活动订单已交承运。',
        items: [
          { ...productCatalog.PRD_007, quantity: 14, unitPrice: 52 },
          { ...productCatalog.PRD_005, quantity: 12, unitPrice: 45 },
        ],
      },
      {
        date: addDays(today, -2),
        sequence: '905',
        customer: '海淀校园店',
        channel: '门店补货',
        status: '待发货',
        stockStatus: '库存充足',
        expectedOffset: 1,
        remark: '演示数据：校园门店晚间补货。',
        items: [
          { ...productCatalog.PRD_006, quantity: 28, unitPrice: 18 },
          { ...productCatalog.PRD_009, quantity: 6, unitPrice: 36 },
        ],
      },
      {
        date: addDays(today, -1),
        sequence: '906',
        customer: '望京企业客户',
        channel: '企业团购',
        status: '待发货',
        stockStatus: '库存充足',
        expectedOffset: 2,
        remark: '演示数据：同客户二次补单。',
        items: [
          { ...productCatalog.PRD_001, quantity: 10, unitPrice: 59.9 },
          { ...productCatalog.PRD_007, quantity: 8, unitPrice: 52.5 },
        ],
      },
      {
        date: today,
        sequence: '907',
        customer: '国贸白领店',
        channel: '门店补货',
        status: '待发货',
        stockStatus: '库存充足',
        expectedOffset: 1,
        remark: '演示数据：今日早班补货单。',
        items: [
          { ...productCatalog.PRD_008, quantity: 18, unitPrice: 16.8 },
          { ...productCatalog.PRD_010, quantity: 6, unitPrice: 42 },
        ],
      },
      {
        date: today,
        sequence: '908',
        customer: '新媒体直播间',
        channel: '线上商城',
        status: '待发货',
        stockStatus: '部分缺货',
        expectedOffset: 2,
        remark: '演示数据：直播补货待补齐库存。',
        items: [
          { ...productCatalog.PRD_007, quantity: 24, unitPrice: 52 },
          { ...productCatalog.PRD_003, quantity: 6, unitPrice: 79 },
        ],
      },
    ];

    salesDemo.forEach((order) => {
      const orderId = `ORD-${compactDate(order.date)}-${order.sequence}`;
      const totalAmount = order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
      insertSalesOrder.run(
        orderId,
        order.customer,
        order.channel,
        order.date,
        addDays(order.date, order.expectedOffset),
        order.status,
        order.stockStatus,
        Number(totalAmount.toFixed(2)),
        itemCount,
        order.remark,
      );

      order.items.forEach((item, index) => {
        insertSalesOrderItem.run(
          `${orderId}-ITEM-${index + 1}`,
          orderId,
          item.id,
          item.sku,
          item.name,
          item.quantity,
          item.unitPrice,
        );
      });
    });

    const purchaseDemo = [
      {
        date: addDays(today, -5),
        sequence: '951',
        supplierId: 'SUP-003',
        status: '已完成',
        source: '系统建议',
        expectedOffset: 2,
        remark: '演示数据：饮料波次补货已完成。',
        item: { ...productCatalog.PRD_010, orderedQty: 180, arrivedQty: 180, unitCost: 24 },
        receiving: { arrivedQty: 180, qualifiedQty: 178, defectQty: 2, status: '已入库', arrivedOffset: 2, inboundStatus: '已入库' },
      },
      {
        date: addDays(today, -3),
        sequence: '952',
        supplierId: 'SUP-001',
        status: '部分到货',
        source: '手工创建',
        expectedOffset: 3,
        remark: '演示数据：清洁用品分批到货。',
        item: { ...productCatalog.PRD_008, orderedQty: 220, arrivedQty: 120, unitCost: 9.5 },
        receiving: { arrivedQty: 120, qualifiedQty: 118, defectQty: 2, status: '部分到货', arrivedOffset: 2, inboundStatus: '待入库' },
      },
      {
        date: addDays(today, -1),
        sequence: '953',
        supplierId: 'SUP-002',
        status: '采购中',
        source: '系统建议',
        expectedOffset: 3,
        remark: '演示数据：纸品促销备货途中。',
        item: { ...productCatalog.PRD_001, orderedQty: 160, arrivedQty: 0, unitCost: 38 },
      },
      {
        date: today,
        sequence: '954',
        supplierId: 'SUP-001',
        status: '待审核',
        source: '手工创建',
        expectedOffset: 4,
        remark: '演示数据：办公用品补货待审核。',
        item: { ...productCatalog.PRD_009, orderedQty: 90, arrivedQty: 0, unitCost: 20 },
      },
    ];

    purchaseDemo.forEach((order) => {
      const purchaseOrderId = `PO-${compactDate(order.date)}-${order.sequence}`;
      const purchaseOrderItemId = `${purchaseOrderId}-ITEM-1`;
      insertPurchaseOrder.run(
        purchaseOrderId,
        order.supplierId,
        order.date,
        addDays(order.date, order.expectedOffset),
        order.status,
        order.source,
        order.remark,
      );
      insertPurchaseOrderItem.run(
        purchaseOrderItemId,
        purchaseOrderId,
        order.item.id,
        order.item.orderedQty,
        order.item.arrivedQty,
        order.item.unitCost,
      );

      if (order.receiving) {
        const receivingId = `RCV-${compactDate(addDays(order.date, order.receiving.arrivedOffset))}-${order.sequence}`;
        insertReceivingNote.run(
          receivingId,
          purchaseOrderId,
          order.supplierId,
          order.item.orderedQty,
          order.receiving.arrivedQty,
          order.receiving.qualifiedQty,
          order.receiving.defectQty,
          order.receiving.status,
          addDays(order.date, order.receiving.arrivedOffset),
        );
        insertReceivingNoteItem.run(
          `${receivingId}-ITEM-1`,
          receivingId,
          purchaseOrderItemId,
          order.item.id,
          order.item.orderedQty,
          order.receiving.arrivedQty,
          order.receiving.qualifiedQty,
          order.receiving.defectQty,
        );
        insertInboundOrder.run(
          `INB-${compactDate(addDays(order.date, order.receiving.arrivedOffset))}-${order.sequence}`,
          receivingId,
          'WH-001',
          order.receiving.qualifiedQty,
          order.receiving.inboundStatus,
          order.receiving.inboundStatus === '已入库' ? addDays(order.date, order.receiving.arrivedOffset) : null,
        );
      }
    });
  });

  transaction();
  ensureFinanceDocuments();
  ensureReceiptRecordItemData();
  ensureDeliveryNotes();
  ensureCustomerProfiles();
  ensureWarehouseShelfData();
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
    const seededCredentialUsers: Array<{ userId: string; username: string; password: string; mustChangePassword: boolean }> = [
      {
        userId: 'USR-001',
        username: 'admin',
        password: DEFAULT_ADMIN_PASSWORD,
        mustChangePassword: false,
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

    clearAllSecurityLocks();
    repairDefaultAdminCredentials();
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
      id, name, customer_type, channel_preference, contact_name, phone, level, last_order_date, total_orders, total_sales, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateCustomer = db.prepare(
    `UPDATE customers
      SET customer_type = ?, channel_preference = ?, last_order_date = ?, total_orders = ?, total_sales = ?, level = ?
      WHERE id = ?`
  );

  const transaction = db.transaction(() => {
    aggregates.forEach((customer) => {
      const existing = findCustomer.get(customer.name);
      if (!existing) {
        insertCustomer.run(
          nextMasterDataId('customers', 'CUS'),
          customer.name,
          'reseller',
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
        'reseller',
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
        id, name, customer_type, channel_preference, contact_name, phone, level, last_order_date, total_orders, total_sales, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nextMasterDataId('customers', 'CUS'),
      customerName,
      'reseller',
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
      SET customer_type = ?, channel_preference = ?, last_order_date = ?, total_orders = ?, total_sales = ?, level = ?, status = ?
      WHERE id = ?`
  ).run(
    'reseller',
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
  // 单据号按“前缀 + 日期 + 自增尾号”生成，并扫描现有最大尾号避免撞号。
  const rows = db.prepare<{ id: string }>(`SELECT id FROM ${tableName} WHERE id LIKE ?`).all(like);
  const matcher = new RegExp(`^${escapeRegExp(prefix)}-${escapeRegExp(datePart)}-(\\d+)$`);
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
    const id = `${prefix}-${datePart}-${String(next).padStart(3, '0')}`;
    if (!exists.get(id)) {
      return id;
    }
    next += 1;
  }
}

export function appendAuditLog(action: string, entityType: string, entityId: string, payload: unknown) {
  db.prepare(
    'INSERT INTO audit_logs (action, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(action, entityType, entityId, JSON.stringify(payload ?? null), new Date().toISOString());
}

initializeDatabase();







