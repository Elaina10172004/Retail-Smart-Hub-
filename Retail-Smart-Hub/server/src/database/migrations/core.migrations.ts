interface MigrationContext {
  ensureColumnExists: (tableName: string, columnName: string, definition: string) => void;
  exec: (sql: string) => void;
  currentDate: string;
}

export function runAuthSecurityMigrations(context: MigrationContext) {
  context.ensureColumnExists('auth_sessions', 'session_id', 'session_id TEXT');
  context.ensureColumnExists('auth_sessions', 'user_agent', 'user_agent TEXT');
  context.ensureColumnExists('auth_sessions', 'ip_address', 'ip_address TEXT');
  context.ensureColumnExists('user_credentials', 'password_updated_at', 'password_updated_at TEXT');
  context.ensureColumnExists('user_credentials', 'must_change_password', 'must_change_password INTEGER NOT NULL DEFAULT 0');
  context.ensureColumnExists('user_credentials', 'temporary_password_issued_at', 'temporary_password_issued_at TEXT');

  context.exec(
    `UPDATE user_credentials SET password_updated_at = COALESCE(password_updated_at, '${context.currentDate}T00:00:00.000Z')`,
  );
  context.exec('UPDATE user_credentials SET must_change_password = COALESCE(must_change_password, 0)');
  context.exec("UPDATE user_credentials SET must_change_password = 1 WHERE password NOT LIKE 'scrypt$%' AND must_change_password = 0");
  context.exec(`
    UPDATE auth_sessions
    SET session_id = COALESCE(NULLIF(session_id, ''), 'SES-' || substr(replace(token, '-', ''), 1, 20))
  `);
  context.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_session_id ON auth_sessions(session_id)');

  context.exec(`
    CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      request_ip TEXT,
      request_user_agent TEXT,
      consumed_ip TEXT,
      consumed_user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  context.exec('CREATE INDEX IF NOT EXISTS idx_auth_password_reset_tokens_user_requested ON auth_password_reset_tokens(user_id, requested_at DESC)');
}

export function runSalesOrderBusinessMigrations(context: Pick<MigrationContext, 'ensureColumnExists' | 'exec'>) {
  context.ensureColumnExists('sales_orders', 'source_order_no', 'source_order_no TEXT');
  context.ensureColumnExists('sales_orders', 'source_system', 'source_system TEXT');
  context.ensureColumnExists('sales_orders', 'biz_no', 'biz_no TEXT');
  context.ensureColumnExists('sales_orders', 'idempotency_key', 'idempotency_key TEXT');
  context.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_orders_idempotency_key ON sales_orders(idempotency_key)');
}
