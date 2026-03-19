interface PreparedQuery<T = unknown> {
  get: (...params: unknown[]) => T | undefined;
  all: (...params: unknown[]) => T[];
}

interface SchemaDatabase {
  exec: (sql: string) => void;
  prepare: <T = unknown>(sql: string) => PreparedQuery<T>;
}

export function getTableCount(db: SchemaDatabase, tableName: string) {
  return db.prepare<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName}`).get()?.count ?? 0;
}

export function ensureColumnExists(db: SchemaDatabase, tableName: string, columnName: string, definition: string) {
  const columns = db.prepare<{ name: string }>(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}
