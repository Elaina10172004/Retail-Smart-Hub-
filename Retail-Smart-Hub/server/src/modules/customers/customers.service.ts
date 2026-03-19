import { appendAuditLog, db, ensureCustomerProfiles, nextMasterDataId } from '../../database/db';

export interface CustomerRecord {
  id: string;
  name: string;
  channelPreference: string;
  contactName: string;
  phone: string;
  level: string;
  totalOrders: number;
  totalSales: number;
  lastOrderDate: string;
  status: 'active' | 'inactive';
}

export interface CustomerSummary {
  customerCount: number;
  activeCustomerCount: number;
  totalSales: number;
  thisMonthActiveCount: number;
}

export interface CreateCustomerPayload {
  name: string;
  channelPreference: string;
  contactName?: string;
  phone?: string;
}

export interface UpdateCustomerPayload extends CreateCustomerPayload {}

export interface ImportSourceRow {
  [key: string]: unknown;
}

export interface ImportRowError {
  rowNumber: number;
  identifier: string;
  reason: string;
}

export interface ImportBatchResult {
  totalCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  createdIds: string[];
  errors: ImportRowError[];
}

export function getCustomerDetail(id: string) {
  return getCustomerById(id);
}

function nextCustomerId() {
  return nextMasterDataId('customers', 'CUS');
}

function normalizeImportKey(value: string) {
  return value.toLowerCase().replace(/[\s_\-()（）[\]{}:：/\\]/g, '');
}

function pickImportValue(row: ImportSourceRow, aliases: string[]) {
  const normalizedAliasSet = new Set(aliases.map((alias) => normalizeImportKey(alias)));
  const matchedEntry = Object.entries(row).find(([key]) => normalizedAliasSet.has(normalizeImportKey(key)));
  return matchedEntry?.[1];
}

function normalizeOptionalString(value: unknown) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim();
  }

  return '';
}

function getCustomerById(id: string) {
  return listCustomers().find((item) => item.id === id) ?? null;
}

export function listCustomers() {
  ensureCustomerProfiles();

  return db.prepare<CustomerRecord>(`
    SELECT
      id,
      name,
      COALESCE(channel_preference, '-') as channelPreference,
      COALESCE(contact_name, '') as contactName,
      COALESCE(phone, '') as phone,
      level,
      total_orders as totalOrders,
      total_sales as totalSales,
      COALESCE(last_order_date, '-') as lastOrderDate,
      status
    FROM customers
    WHERE status <> 'deleted'
    ORDER BY total_sales DESC, last_order_date DESC, id ASC
  `).all();
}

export function getCustomerSummary(): CustomerSummary {
  ensureCustomerProfiles();
  const currentMonth = new Date().toISOString().slice(0, 7);

  return {
    customerCount:
      db.prepare<{ count: number }>("SELECT COUNT(*) as count FROM customers WHERE status <> 'deleted'").get()?.count ?? 0,
    activeCustomerCount:
      db.prepare<{ count: number }>("SELECT COUNT(*) as count FROM customers WHERE status = 'active'").get()?.count ?? 0,
    totalSales:
      db.prepare<{ total: number }>("SELECT COALESCE(SUM(total_sales), 0) as total FROM customers WHERE status <> 'deleted'").get()?.total ?? 0,
    thisMonthActiveCount:
      db.prepare<{ count: number }>(
        "SELECT COUNT(*) as count FROM customers WHERE status <> 'deleted' AND substr(last_order_date, 1, 7) = ?"
      ).get(currentMonth)?.count ?? 0,
  };
}

export function createCustomer(payload: CreateCustomerPayload) {
  ensureCustomerProfiles();

  const normalizedName = payload.name.trim();
  const normalizedChannel = payload.channelPreference.trim();
  const normalizedContactName = payload.contactName?.trim() || null;
  const normalizedPhone = payload.phone?.trim() || null;

  const existing = db.prepare<{ id: string; status: string }>('SELECT id, status FROM customers WHERE name = ?').get(normalizedName);

  if (existing?.status && existing.status !== 'deleted') {
    throw new Error('Customer already exists');
  }

  if (existing?.status === 'deleted') {
    db.prepare(
      `UPDATE customers
        SET channel_preference = ?, contact_name = ?, phone = ?, status = ?
        WHERE id = ?`
    ).run(normalizedChannel, normalizedContactName, normalizedPhone, 'active', existing.id);

    appendAuditLog('restore_customer', 'customer', existing.id, {
      channelPreference: normalizedChannel,
    });

    return getCustomerById(existing.id) as CustomerRecord;
  }

  const customerId = nextCustomerId();

  db.prepare(
    `INSERT INTO customers (
      id, name, channel_preference, contact_name, phone, level, last_order_date, total_orders, total_sales, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(customerId, normalizedName, normalizedChannel, normalizedContactName, normalizedPhone, 'C', null, 0, 0, 'active');

  appendAuditLog('create_customer', 'customer', customerId, {
    channelPreference: normalizedChannel,
  });

  return getCustomerById(customerId) as CustomerRecord;
}

export function importCustomers(rows: ImportSourceRow[]): ImportBatchResult {
  ensureCustomerProfiles();

  const errors: ImportRowError[] = [];
  const createdIds: string[] = [];
  let createdCount = 0;
  let skippedCount = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = normalizeOptionalString(pickImportValue(row, ['客户名称', '客户名', '客户', '名称', 'name', 'customerName', 'customer']));
    const channelPreference = normalizeOptionalString(
      pickImportValue(row, ['渠道偏好', '渠道', 'channelPreference', 'channel'])
    );
    const contactName = normalizeOptionalString(pickImportValue(row, ['联系人', '联系', 'contactName', 'contact']));
    const phone = normalizeOptionalString(pickImportValue(row, ['联系电话', '电话', '手机号', '手机', 'phone', 'mobile']));

    if (!name && !channelPreference && !contactName && !phone) {
      skippedCount += 1;
      return;
    }

    if (!name || !channelPreference) {
      errors.push({
        rowNumber,
        identifier: name || `row-${rowNumber}`,
        reason: `缺少必填字段：${[!name ? '客户名称' : '', !channelPreference ? '渠道' : ''].filter(Boolean).join('、')}`,
      });
      return;
    }

    try {
      const customer = createCustomer({
        name,
        channelPreference,
        contactName: contactName || undefined,
        phone: phone || undefined,
      });
      createdCount += 1;
      createdIds.push(customer.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Create customer failed';
      if (reason === 'Customer already exists') {
        skippedCount += 1;
        return;
      }

      errors.push({
        rowNumber,
        identifier: name || `row-${rowNumber}`,
        reason,
      });
    }
  });

  return {
    totalCount: rows.length,
    createdCount,
    skippedCount,
    errorCount: errors.length,
    createdIds,
    errors,
  };
}

export function updateCustomer(id: string, payload: UpdateCustomerPayload) {
  ensureCustomerProfiles();

  const existing = db.prepare<{ id: string }>("SELECT id FROM customers WHERE id = ? AND status <> 'deleted'").get(id);
  if (!existing) {
    throw new Error('Customer not found');
  }

  const normalizedName = payload.name.trim();
  const duplicate = db.prepare<{ id: string }>(
    "SELECT id FROM customers WHERE name = ? AND id <> ? AND status <> 'deleted'"
  ).get(normalizedName, id);
  if (duplicate) {
    throw new Error('Customer name already exists');
  }

  db.prepare(
    `UPDATE customers
      SET name = ?, channel_preference = ?, contact_name = ?, phone = ?
      WHERE id = ?`
  ).run(
    normalizedName,
    payload.channelPreference.trim(),
    payload.contactName?.trim() || null,
    payload.phone?.trim() || null,
    id
  );

  appendAuditLog('update_customer', 'customer', id, {
    channelPreference: payload.channelPreference,
  });

  return getCustomerById(id) as CustomerRecord;
}

export function toggleCustomerStatus(id: string) {
  ensureCustomerProfiles();

  const existing = db.prepare<{ id: string; name: string; status: 'active' | 'inactive' }>(
    "SELECT id, name, status FROM customers WHERE id = ? AND status <> 'deleted'"
  ).get(id);

  if (!existing) {
    throw new Error('Customer not found');
  }

  const nextStatus = existing.status === 'active' ? 'inactive' : 'active';

  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run(nextStatus, id);

  appendAuditLog('toggle_customer_status', 'customer', id, {
    name: existing.name,
    previousStatus: existing.status,
    nextStatus,
  });

  return getCustomerById(id) as CustomerRecord;
}

export function deleteCustomer(id: string) {
  ensureCustomerProfiles();

  const existing = db.prepare<{ id: string; name: string; status: 'active' | 'inactive' }>(
    "SELECT id, name, status FROM customers WHERE id = ? AND status <> 'deleted'"
  ).get(id);

  if (!existing) {
    throw new Error('Customer not found');
  }

  if (existing.status !== 'inactive') {
    throw new Error('Customer must be inactive before deletion');
  }

  db.prepare("UPDATE customers SET status = 'deleted' WHERE id = ?").run(id);

  appendAuditLog('delete_customer', 'customer', id, {
    name: existing.name,
  });

  return true;
}
