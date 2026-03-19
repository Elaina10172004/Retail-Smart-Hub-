import { getArrivalDetail, listArrivals } from '../../arrival/arrival.service';
import { getPasswordPolicySummary, getPasswordSecuritySummary, listUserSessions } from '../../../shared/auth';
import { getCustomerDetail, getCustomerSummary, listCustomers } from '../../customers/customers.service';
import { getDashboardOverview } from '../../dashboard/dashboard.service';
import {
  getFinanceOverview,
  getPayableDetail,
  getReceivableDetail,
  listPayables,
  listPaymentRecords,
  listReceivables,
  listReceiptRecords,
} from '../../finance/finance.service';
import { getInboundDetail, listInbounds } from '../../inbound/inbound.service';
import { getInventoryAlerts, getInventoryDetail, getInventoryOverview, listInventory } from '../../inventory/inventory.service';
import { getOrderDetail, listOrders } from '../../orders/orders.service';
import { getProcurementOrderDetail, listProcurementOrders } from '../../procurement/procurement.service';
import { getReportOverview } from '../../reports/reports.service';
import { getShipmentDetail, listShipments } from '../../shipping/shipping.service';
import { getAccessOverview, getMasterDataOverview } from '../../settings/settings.service';
import { listAuditLogs, listSystemNotifications } from '../../system/system.service';
import { listMemoryFacts } from '../memory-update.service';
import { getProfileMemoryByScope, type ProfileMemoryScope } from '../profile-memory.service';
import type { AiToolCallRecord, ReadOnlyToolName } from '../dto/tool.dto';

interface TypedReadOnlyToolRequest {
  toolName: ReadOnlyToolName;
  args: Record<string, unknown>;
  userId: string;
  tenantId?: string;
  sessionId?: string;
  username: string;
  permissions: string[];
  token: string;
}

interface TypedReadOnlyToolExecution {
  toolCall: AiToolCallRecord;
  toolContext: string;
  usedFallback: boolean;
  data?: Record<string, unknown>;
}

function toNumberLimit(value: unknown, fallback = 20, max = 50) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(max, Math.floor(value)));
  }
  return fallback;
}

function toKeyword(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function toMemoryScopeType(value: unknown): ProfileMemoryScope {
  if (value === 'global' || value === 'tenant' || value === 'session') {
    return value;
  }
  return 'user';
}

function resolveMemoryScopeInput(
  request: TypedReadOnlyToolRequest,
  scopeType: ProfileMemoryScope,
  scopeIdRaw?: string,
): {
  scope: ProfileMemoryScope;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
} {
  const scopeId = scopeIdRaw?.trim() || undefined;
  if (scopeType === 'global') {
    return { scope: 'global' };
  }
  if (scopeType === 'tenant') {
    const tenantId = scopeId || request.tenantId;
    if (!tenantId) {
      throw new Error('tenant scope requires tenantId or scopeId');
    }
    return { scope: 'tenant', tenantId };
  }
  if (scopeType === 'session') {
    const sessionId = scopeId || request.sessionId;
    if (!sessionId) {
      throw new Error('session scope requires sessionId or scopeId');
    }
    return {
      scope: 'session',
      tenantId: request.tenantId,
      userId: request.userId,
      sessionId,
    };
  }
  const userId = scopeId || request.userId;
  if (!userId) {
    throw new Error('user scope requires userId or scopeId');
  }
  return {
    scope: 'user',
    tenantId: request.tenantId,
    userId,
  };
}

export function executeTypedReadOnlyTool(request: TypedReadOnlyToolRequest): TypedReadOnlyToolExecution {
  const { toolName, args } = request;
  try {
    switch (toolName) {
      case 'get_dashboard_overview': {
        const overview = getDashboardOverview();
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回仪表盘概览。' },
          toolContext: `仪表盘概览：\n${JSON.stringify(overview, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'list_orders': {
        const rows = listOrders();
        const limit = toNumberLimit(args.limit, 20);
        const status = toKeyword(args.status);
        const customerKeyword = toKeyword(args.customerKeyword).toLowerCase();
        const dateFrom = toKeyword(args.dateFrom);
        const dateTo = toKeyword(args.dateTo);
        const filtered = rows
          .filter((item) => (!status ? true : item.status === status))
          .filter((item) => (!customerKeyword ? true : item.customer.toLowerCase().includes(customerKeyword)))
          .filter((item) => (!dateFrom ? true : item.date >= dateFrom))
          .filter((item) => (!dateTo ? true : item.date <= dateTo))
          .slice(0, limit);
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${filtered.length} 条订单。` },
          toolContext: `订单列表：\n${JSON.stringify(filtered, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_order_detail': {
        const id = toKeyword(args.orderId);
        const detail = id ? getOrderDetail(id) : null;
        if (!detail) {
          return {
            toolCall: { name: toolName, status: 'disabled', summary: '未找到订单详情。' },
            toolContext: '未找到订单详情。',
            usedFallback: false,
          };
        }
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回订单 ${id} 详情。` },
          toolContext: `订单详情：\n${JSON.stringify(detail, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'list_procurement_orders': {
        const rows = listProcurementOrders();
        const limit = toNumberLimit(args.limit, 20);
        const status = toKeyword(args.status);
        const supplierKeyword = toKeyword(args.supplierKeyword).toLowerCase();
        const filtered = rows
          .filter((item) => (!status ? true : item.status === status))
          .filter((item) => (!supplierKeyword ? true : item.supplier.toLowerCase().includes(supplierKeyword)))
          .slice(0, limit);
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${filtered.length} 条采购单。` },
          toolContext: `采购单列表：\n${JSON.stringify(filtered, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_procurement_detail': {
        const id = toKeyword(args.procurementId);
        const detail = id ? getProcurementOrderDetail(id) : null;
        if (!detail) {
          return {
            toolCall: { name: toolName, status: 'disabled', summary: '未找到采购单详情。' },
            toolContext: '未找到采购单详情。',
            usedFallback: false,
          };
        }
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回采购单 ${id} 详情。` },
          toolContext: `采购单详情：\n${JSON.stringify(detail, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_inventory_overview': {
        const overview = getInventoryOverview();
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回库存总览。' },
          toolContext: `库存总览：\n${JSON.stringify(overview, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'list_inventory_alerts': {
        const rows = getInventoryAlerts().slice(0, toNumberLimit(args.limit, 20));
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条库存预警。` },
          toolContext: `库存预警：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'query_inventory_item': {
        const sku = toKeyword(args.sku);
        const keyword = toKeyword(args.keyword).toLowerCase();
        const rows = (sku ? [getInventoryDetail(sku)].filter(Boolean) : listInventory())
          .filter((item) => {
            if (!keyword) {
              return true;
            }
            const text = `${item?.id || ''} ${item?.name || ''}`.toLowerCase();
            return text.includes(keyword);
          })
          .slice(0, toNumberLimit(args.limit, 20)) as Array<Record<string, unknown>>;
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条库存项。` },
          toolContext: `库存项：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_finance_overview': {
        const overview = getFinanceOverview();
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回财务总览。' },
          toolContext: `财务总览：\n${JSON.stringify(overview, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'list_receivables': {
        const rows = listReceivables().slice(0, toNumberLimit(args.limit, 20));
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条应收单。` },
          toolContext: `应收单：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_receivable_detail': {
        const id = toKeyword(args.receivableId);
        const detail = id ? getReceivableDetail(id) : null;
        return detail
          ? {
              toolCall: { name: toolName, status: 'completed', summary: `已返回应收 ${id} 详情。` },
              toolContext: `应收详情：\n${JSON.stringify(detail, null, 2)}`,
              usedFallback: false,
            }
          : {
              toolCall: { name: toolName, status: 'disabled', summary: '未找到应收详情。' },
              toolContext: '未找到应收详情。',
              usedFallback: false,
            };
      }
      case 'list_receipt_records': {
        const rows = listReceiptRecords(toKeyword(args.receivableId) || undefined).slice(0, toNumberLimit(args.limit, 20));
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条收款记录。` },
          toolContext: `收款记录：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'list_payables': {
        const rows = listPayables().slice(0, toNumberLimit(args.limit, 20));
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条应付单。` },
          toolContext: `应付单：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_payable_detail': {
        const id = toKeyword(args.payableId);
        const detail = id ? getPayableDetail(id) : null;
        return detail
          ? {
              toolCall: { name: toolName, status: 'completed', summary: `已返回应付 ${id} 详情。` },
              toolContext: `应付详情：\n${JSON.stringify(detail, null, 2)}`,
              usedFallback: false,
            }
          : {
              toolCall: { name: toolName, status: 'disabled', summary: '未找到应付详情。' },
              toolContext: '未找到应付详情。',
              usedFallback: false,
            };
      }
      case 'list_payment_records': {
        const rows = listPaymentRecords(toKeyword(args.payableId) || undefined).slice(0, toNumberLimit(args.limit, 20));
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条付款记录。` },
          toolContext: `付款记录：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'list_customers': {
        const keyword = toKeyword(args.keyword).toLowerCase();
        const status = toKeyword(args.status);
        const phone = toKeyword(args.phone);
        const rows = listCustomers()
          .filter((item) => (!status ? true : item.status === status))
          .filter((item) => (!phone ? true : item.phone === phone))
          .filter((item) =>
            !keyword ? true : `${item.name} ${item.contactName} ${item.channelPreference}`.toLowerCase().includes(keyword),
          )
          .slice(0, toNumberLimit(args.limit, 20));
        return {
          toolCall: { name: toolName, status: 'completed', summary: `已返回 ${rows.length} 条客户。` },
          toolContext: `客户列表：\n${JSON.stringify(rows, null, 2)}`,
          usedFallback: false,
        };
      }
      case 'get_customer_detail': {
        const id = toKeyword(args.customerId) || toKeyword(args.keyword);
        const detail = id ? getCustomerDetail(id) : null;
        return detail
          ? {
              toolCall: { name: toolName, status: 'completed', summary: `已返回客户 ${id} 详情。` },
              toolContext: `客户详情：\n${JSON.stringify(detail, null, 2)}`,
              usedFallback: false,
            }
          : {
              toolCall: { name: toolName, status: 'disabled', summary: '未找到客户详情。' },
              toolContext: '未找到客户详情。',
              usedFallback: false,
            };
      }
      case 'get_customer_summary':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回客户汇总。' },
          toolContext: `客户汇总：\n${JSON.stringify(getCustomerSummary(), null, 2)}`,
          usedFallback: false,
        };
      case 'get_reports_overview':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回报表总览。' },
          toolContext: `报表总览：\n${JSON.stringify(getReportOverview(), null, 2)}`,
          usedFallback: false,
        };
      case 'list_audit_logs':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回审计日志。' },
          toolContext: `审计日志：\n${JSON.stringify(listAuditLogs(toNumberLimit(args.limit, 20), toKeyword(args.entityType) || undefined, toKeyword(args.action) || undefined), null, 2)}`,
          usedFallback: false,
        };
      case 'list_arrivals':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回到货列表。' },
          toolContext: `到货列表：\n${JSON.stringify(listArrivals().slice(0, toNumberLimit(args.limit, 20)), null, 2)}`,
          usedFallback: false,
        };
      case 'get_arrival_detail': {
        const id = toKeyword(args.arrivalId);
        const detail = id ? getArrivalDetail(id) : null;
        return detail
          ? {
              toolCall: { name: toolName, status: 'completed', summary: `已返回到货单 ${id} 详情。` },
              toolContext: `到货详情：\n${JSON.stringify(detail, null, 2)}`,
              usedFallback: false,
            }
          : {
              toolCall: { name: toolName, status: 'disabled', summary: '未找到到货详情。' },
              toolContext: '未找到到货详情。',
              usedFallback: false,
            };
      }
      case 'list_inbounds':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回入库列表。' },
          toolContext: `入库列表：\n${JSON.stringify(listInbounds().slice(0, toNumberLimit(args.limit, 20)), null, 2)}`,
          usedFallback: false,
        };
      case 'get_inbound_detail': {
        const id = toKeyword(args.inboundId);
        const detail = id ? getInboundDetail(id) : null;
        return detail
          ? {
              toolCall: { name: toolName, status: 'completed', summary: `已返回入库单 ${id} 详情。` },
              toolContext: `入库详情：\n${JSON.stringify(detail, null, 2)}`,
              usedFallback: false,
            }
          : {
              toolCall: { name: toolName, status: 'disabled', summary: '未找到入库详情。' },
              toolContext: '未找到入库详情。',
              usedFallback: false,
            };
      }
      case 'list_shipments':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回发货列表。' },
          toolContext: `发货列表：\n${JSON.stringify(listShipments().slice(0, toNumberLimit(args.limit, 20)), null, 2)}`,
          usedFallback: false,
        };
      case 'get_shipment_detail': {
        const id = toKeyword(args.shipmentId);
        const detail = id ? getShipmentDetail(id) : null;
        return detail
          ? {
              toolCall: { name: toolName, status: 'completed', summary: `已返回发货单 ${id} 详情。` },
              toolContext: `发货详情：\n${JSON.stringify(detail, null, 2)}`,
              usedFallback: false,
            }
          : {
              toolCall: { name: toolName, status: 'disabled', summary: '未找到发货详情。' },
              toolContext: '未找到发货详情。',
              usedFallback: false,
            };
      }
      case 'get_access_overview':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回权限与角色概览。' },
          toolContext: `权限概览：\n${JSON.stringify(getAccessOverview(), null, 2)}`,
          usedFallback: false,
        };
      case 'get_master_data_overview':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回基础资料概览。' },
          toolContext: `基础资料概览：\n${JSON.stringify(getMasterDataOverview(), null, 2)}`,
          usedFallback: false,
        };
      case 'get_password_policy':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回密码策略摘要。' },
          toolContext: `密码策略：\n${JSON.stringify(getPasswordPolicySummary(), null, 2)}`,
          usedFallback: false,
        };
      case 'get_password_security':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回当前用户密码安全摘要。' },
          toolContext: `密码安全：\n${JSON.stringify(getPasswordSecuritySummary(request.userId), null, 2)}`,
          usedFallback: false,
        };
      case 'list_user_sessions':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回当前用户会话列表。' },
          toolContext: `会话列表：\n${JSON.stringify(listUserSessions(request.userId, request.token), null, 2)}`,
          usedFallback: false,
        };
      case 'list_system_notifications':
        return {
          toolCall: { name: toolName, status: 'completed', summary: '已返回系统通知。' },
          toolContext: `系统通知：\n${JSON.stringify(listSystemNotifications(toNumberLimit(args.limit, 8), request.permissions), null, 2)}`,
          usedFallback: false,
        };
      case 'get_profile_memory': {
        const scopeType = toMemoryScopeType(args.scopeType);
        const scopeInput = resolveMemoryScopeInput(request, scopeType, toKeyword(args.scopeId));
        const profile = getProfileMemoryByScope(scopeInput);
        const summary =
          profile.records.length > 0
            ? `已返回画像记忆（${profile.records.length} 个作用域记录）。`
            : '当前没有已生效的画像记忆。';
        return {
          toolCall: {
            name: toolName,
            status: 'completed',
            summary,
          },
          toolContext: `画像记忆：\n${JSON.stringify(
            {
              scope: scopeInput.scope,
              tenantId: scopeInput.tenantId,
              userId: scopeInput.userId,
              sessionId: scopeInput.sessionId,
              profile: profile.profile,
              records: profile.records,
              version: profile.version,
              updatedAt: profile.updatedAt,
              updatedBy: profile.updatedBy,
              lastConfirmedAt: profile.lastConfirmedAt,
            },
            null,
            2,
          )}`,
          usedFallback: false,
          data: {
            profile: profile.profile,
            scopeRecords: profile.records,
            version: profile.version,
            updatedAt: profile.updatedAt,
            updatedBy: profile.updatedBy,
            lastConfirmedAt: profile.lastConfirmedAt,
          },
        };
      }
      case 'list_memory_facts': {
        const scopeType = toMemoryScopeType(args.scopeType);
        const scopeInput = resolveMemoryScopeInput(request, scopeType, toKeyword(args.scopeId));
        const includeEpisodic =
          typeof args.includeEpisodic === 'boolean' ? args.includeEpisodic : args.includeEpisodic === 'true';
        const facts = listMemoryFacts({
          tenantId: scopeInput.tenantId,
          userId: scopeInput.userId,
          sessionId: scopeInput.sessionId,
          includeEpisodic,
          limit: toNumberLimit(args.limit, 20),
        });
        return {
          toolCall: {
            name: toolName,
            status: 'completed',
            summary: facts.length > 0 ? `已返回 ${facts.length} 条记忆事实。` : '当前没有可用记忆事实。',
          },
          toolContext: `记忆事实：\n${JSON.stringify(facts, null, 2)}`,
          usedFallback: false,
          data: {
            facts,
          },
        };
      }
      default:
        return {
          toolCall: {
            name: toolName,
            status: 'disabled',
            summary: `未实现的 typed 只读工具：${toolName}`,
          },
          toolContext: `未实现的 typed 只读工具：${toolName}`,
          usedFallback: false,
        };
    }
  } catch (error) {
    return {
      toolCall: {
        name: toolName,
        status: 'disabled',
        summary: `工具执行失败：${error instanceof Error ? error.message : 'unknown error'}`,
      },
      toolContext: `工具执行失败：${error instanceof Error ? error.message : 'unknown error'}`,
      usedFallback: false,
    };
  }
}

