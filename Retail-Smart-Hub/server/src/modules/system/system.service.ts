import { db } from '../../database/db';
import { currentDateString, formatCurrency } from '../../shared/format';
import { listReceivables } from '../finance/finance.service';
import { getInventoryAlerts } from '../inventory/inventory.service';
import { getProcurementSuggestions, listProcurementOrders } from '../procurement/procurement.service';
import { listShipments } from '../shipping/shipping.service';

export interface AuditLogRecord {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  payload: string;
  createdAt: string;
}

export type SystemNotificationLevel = 'critical' | 'warning' | 'info' | 'success';

export interface SystemNotificationRecord {
  id: string;
  title: string;
  description: string;
  moduleId: string;
  level: SystemNotificationLevel;
  createdAt: string;
  requiredPermissions?: string[];
}

const LEVEL_WEIGHT: Record<SystemNotificationLevel, number> = {
  critical: 4,
  warning: 3,
  info: 2,
  success: 1,
};

function normalizeNotificationTime(value: string, fallbackTime = 'T00:00:00.000Z') {
  if (!value) {
    return `${currentDateString()}${fallbackTime}`;
  }

  return value.includes('T') ? value : `${value}${fallbackTime}`;
}

function hasAnyPermission(permissions: string[], requiredPermissions: string[] = []) {
  if (requiredPermissions.length === 0) {
    return true;
  }

  return requiredPermissions.some((permission) => permissions.includes(permission));
}

export function listAuditLogs(limit = 50, entityType?: string, action?: string) {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (entityType) {
    conditions.push('entity_type = ?');
    params.push(entityType);
  }

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  return db.prepare<AuditLogRecord>(`
    SELECT
      id,
      action,
      entity_type as entityType,
      entity_id as entityId,
      COALESCE(payload, '{}') as payload,
      created_at as createdAt
    FROM audit_logs
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params);
}

export function listSystemNotifications(limit = 8, permissions: string[] = []) {
  const notifications: SystemNotificationRecord[] = [];

  const alerts = getInventoryAlerts().slice(0, 3);
  alerts.forEach((alert) => {
    notifications.push({
      id: `inventory-${alert.sku}`,
      title: alert.status === '缺货' ? `${alert.name} 已缺货` : `${alert.name} 库存预警`,
      description: `当前库存 ${alert.currentStock}，安全库存 ${alert.safeStock}，建议补货缺口 ${alert.gap}。`,
      moduleId: 'inventory',
      level: alert.status === '缺货' ? 'critical' : 'warning',
      createdAt: normalizeNotificationTime(currentDateString(), 'T08:00:00.000Z'),
      requiredPermissions: ['inventory.view'],
    });
  });

  const pendingShipments = listShipments().filter((item) => item.status === '待发货');
  if (pendingShipments.length > 0) {
    const shortageCount = pendingShipments.filter((item) => item.stockStatus === '待补货').length;
    const newestShipmentTime = pendingShipments
      .map((item) => normalizeNotificationTime(item.createdAt || currentDateString(), 'T09:00:00.000Z'))
      .sort((left, right) => right.localeCompare(left))[0] || normalizeNotificationTime(currentDateString(), 'T09:00:00.000Z');
    notifications.push({
      id: `shipping-pending-${pendingShipments.length}`,
      title: `待发货单 ${pendingShipments.length} 笔`,
      description:
        shortageCount > 0
          ? `${shortageCount} 笔订单仍待补货，请优先处理可直接发货订单。`
          : '所有待发货订单库存充足，可安排拣货和出库。',
      moduleId: 'shipping',
      level: shortageCount > 0 ? 'warning' : 'info',
      createdAt: newestShipmentTime,
      requiredPermissions: ['shipping.dispatch', 'orders.view', 'orders.create'],
    });
  }

  const pendingProcurements = listProcurementOrders().filter((item) => item.status !== '已完成').slice(0, 3);
  const suggestion = getProcurementSuggestions();
  if (pendingProcurements.length > 0 || suggestion.lowStockItemCount > 0) {
    const newestProcurementTime = pendingProcurements
      .map((item) => normalizeNotificationTime(item.createDate, 'T10:00:00.000Z'))
      .sort((left, right) => right.localeCompare(left))[0] || normalizeNotificationTime(currentDateString(), 'T10:00:00.000Z');
    notifications.push({
      id: `procurement-${pendingProcurements.length}-${suggestion.lowStockItemCount}`,
      title: `采购侧待处理事项 ${pendingProcurements.length + suggestion.lowStockItemCount} 项`,
      description:
        suggestion.lowStockItemCount > 0
          ? suggestion.message
          : `当前仍有 ${pendingProcurements.length} 张采购单未完结，请跟进到货与入库。`,
      moduleId: 'procurement',
      level: suggestion.lowStockItemCount > 0 ? 'warning' : 'info',
      createdAt: newestProcurementTime,
      requiredPermissions: ['procurement.manage'],
    });
  }

  const overdueReceivables = listReceivables()
    .filter((item) => item.daysOverdue > 0 && item.remainingAmount > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, 2);

  overdueReceivables.forEach((item) => {
    notifications.push({
      id: `finance-${item.id}`,
      title: `${item.customer} 回款逾期 ${item.daysOverdue} 天`,
      description: `待收金额 ${formatCurrency(item.remainingAmount)}，应尽快跟进收款。`,
      moduleId: 'finance',
      level: item.daysOverdue >= 7 ? 'critical' : 'warning',
      createdAt: normalizeNotificationTime(item.dueDate, 'T11:00:00.000Z'),
      requiredPermissions: ['finance.view'],
    });
  });

  const recentAudit = listAuditLogs(2);
  recentAudit.forEach((item) => {
    notifications.push({
      id: `audit-${item.id}`,
      title: `最近操作：${item.action}`,
      description: `${item.entityType} / ${item.entityId}`,
      moduleId: 'settings',
      level: 'info',
      createdAt: normalizeNotificationTime(item.createdAt, 'T12:00:00.000Z'),
      requiredPermissions: ['settings.access-control'],
    });
  });

  return notifications
    .filter((item) => hasAnyPermission(permissions, item.requiredPermissions))
    .sort((left, right) => {
      const timeGap = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      if (timeGap !== 0) {
        return timeGap;
      }

      return LEVEL_WEIGHT[right.level] - LEVEL_WEIGHT[left.level];
    })
    .slice(0, Math.max(limit, 1));
}
