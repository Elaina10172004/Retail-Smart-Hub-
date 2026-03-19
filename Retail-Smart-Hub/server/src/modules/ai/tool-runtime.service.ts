import { z } from 'zod';
import { planRuntimeWriteAction, type WriteToolName } from './action.service';
import { db } from '../../database/db';
import type { AiApproval, AiPendingAction, AiToolCallRecord, ReadOnlyToolName } from './dto/tool.dto';
import { READ_ONLY_TOOL_DESCRIPTORS } from './registry/read-only-tools.registry';
import { executeTypedReadOnlyTool } from './tool/typed-read-executor';
import {
  applyLowRiskMemoryUpdate,
  deleteMemoryFactById,
  planMemoryUpdate,
  type MemoryDecisionAction,
  type MemoryUpdateDecision,
} from './memory-update.service';
import { getProfileMemory } from './profile-memory.service';
import { resolveActiveSupplierReference } from '../settings/settings.service';

interface RuntimeToolExecutionRequest {
  prompt: string;
  userId: string;
  tenantId?: string;
  sessionId?: string;
  username: string;
  permissions: string[];
  token: string;
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: AiToolCallRecord[];
    pendingActionId?: string;
    pendingActionName?: string;
    pendingActionStatus?: AiPendingAction['status'];
  }>;
}

export interface RuntimeToolResult {
  ok: boolean;
  code: 'ok' | 'approval_required' | 'invalid_tool' | 'invalid_arguments' | 'permission_denied' | 'no_result' | 'execution_error';
  message: string;
  summary: string;
  context: string;
  data?: Record<string, unknown>;
  pendingAction?: AiPendingAction;
  approval?: AiApproval;
}

interface RuntimeToolExecutionResult {
  toolCall: AiToolCallRecord;
  toolContext: string;
  pendingAction?: AiPendingAction;
  approval?: AiApproval;
  result: RuntimeToolResult;
}

interface RuntimeToolSchemaDefinition {
  type: 'read' | 'write';
  name: string;
  description: string;
  requiredPermissions: string[];
  parameters: Record<string, unknown>;
  parser: z.ZodTypeAny;
}

interface DeepSeekToolDefinition {
  type: 'function';
  metadata?: {
    access_mode?: 'read' | 'write';
    origin?: 'node' | 'builtin';
  };
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const READ_TOOL_NAME_SET = new Set<ReadOnlyToolName>(READ_ONLY_TOOL_DESCRIPTORS.map((item) => item.name));

const ORDER_ID_REGEX = /^ORD-\d{8}-\d+$/i;
const PROCUREMENT_ID_REGEX = /^PO-\d{8}-\d+$/i;
const ARRIVAL_ID_REGEX = /^RCV-\d{8}-\d+$/i;
const INBOUND_ID_REGEX = /^INB-\d{8}-\d+$/i;
const SHIPMENT_ID_REGEX = /^SHP-\d{8}-\d+$/i;
const RECEIVABLE_ID_REGEX = /^AR-\d{8}-\d+$/i;
const PAYABLE_ID_REGEX = /^AP-\d{8}-\d+$/i;
const CUSTOMER_ID_REGEX = /^CUS-\d+$/i;

type MemoryWriteToolName = 'update_profile_memory' | 'supersede_memory_fact' | 'delete_memory_fact';
type RuntimeWriteToolName = WriteToolName | MemoryWriteToolName;

const MEMORY_WRITE_TOOL_NAMES = new Set<MemoryWriteToolName>([
  'update_profile_memory',
  'supersede_memory_fact',
  'delete_memory_fact',
]);
const MEMORY_HIGH_RISK_PERMISSION = 'settings.access-control';

const integerLimitSchema = z.coerce.number().int().min(1).max(50).optional();
const keywordSchema = z.string().trim().min(1).max(120).optional();
const dateStringSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const booleanOptionalSchema = z.coerce.boolean().optional();
const profileScopeSchema = z.enum(['global', 'tenant', 'user', 'session']).optional();
const memoryTargetSchema = z
  .enum([
    'assistantDisplayName',
    'assistantAliases',
    'userPreferredName',
    'language',
    'stylePreferences',
    'permissionPolicyNote',
    'financePolicyNote',
    'accountPolicyNote',
  ])
  .optional();

const readIdSchema = (key: string, pattern: RegExp) =>
  z
    .object({
      [key]: z.string().trim().regex(pattern),
    })
    .strict();

const READ_TOOL_SCHEMAS: Partial<Record<ReadOnlyToolName, RuntimeToolSchemaDefinition>> = {
  list_orders: {
    type: 'read',
    name: 'list_orders',
    description: 'List sales orders with strict filters.',
    requiredPermissions: ['orders.view', 'orders.create'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待发货', '已发货', '已完成', '已取消'] },
        customerKeyword: { type: 'string' },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待发货', '已发货', '已完成', '已取消']).optional(),
        customerKeyword: keywordSchema,
        dateFrom: dateStringSchema.optional(),
        dateTo: dateStringSchema.optional(),
        limit: integerLimitSchema,
      })
      .strict(),
  },
  get_order_detail: {
    type: 'read',
    name: 'get_order_detail',
    description: 'Get order detail by ID.',
    requiredPermissions: ['orders.view', 'orders.create'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['orderId'],
      properties: {
        orderId: { type: 'string', description: 'ORD-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('orderId', ORDER_ID_REGEX),
  },
  get_procurement_detail: {
    type: 'read',
    name: 'get_procurement_detail',
    description: 'Get procurement detail by ID.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['procurementId'],
      properties: {
        procurementId: { type: 'string', description: 'PO-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('procurementId', PROCUREMENT_ID_REGEX),
  },
  list_procurement_orders: {
    type: 'read',
    name: 'list_procurement_orders',
    description: 'List procurement orders.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待审核', '待到货', '部分到货', '已完成'] },
        supplierKeyword: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待审核', '待到货', '部分到货', '已完成']).optional(),
        supplierKeyword: keywordSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
  query_inventory_item: {
    type: 'read',
    name: 'query_inventory_item',
    description: 'Query inventory by SKU or keyword.',
    requiredPermissions: ['inventory.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sku: { type: 'string', description: 'SKU-1001' },
        keyword: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        sku: z.string().trim().regex(/^SKU-\d{4,}$/i).optional(),
        keyword: keywordSchema,
        limit: integerLimitSchema,
      })
      .strict()
      .refine((value) => Boolean(value.sku || value.keyword), { message: 'Either sku or keyword is required' }),
  },
  get_receivable_detail: {
    type: 'read',
    name: 'get_receivable_detail',
    description: 'Get receivable detail by ID.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['receivableId'],
      properties: {
        receivableId: { type: 'string', description: 'AR-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('receivableId', RECEIVABLE_ID_REGEX),
  },
  get_payable_detail: {
    type: 'read',
    name: 'get_payable_detail',
    description: 'Get payable detail by ID.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['payableId'],
      properties: {
        payableId: { type: 'string', description: 'AP-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('payableId', PAYABLE_ID_REGEX),
  },
};

const READ_TOOL_SCHEMAS_PHASE_2: Partial<Record<ReadOnlyToolName, RuntimeToolSchemaDefinition>> = {
  get_arrival_detail: {
    type: 'read',
    name: 'get_arrival_detail',
    description: 'Get arrival detail by ID.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['arrivalId'],
      properties: {
        arrivalId: { type: 'string', description: 'RCV-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('arrivalId', ARRIVAL_ID_REGEX),
  },
  get_inbound_detail: {
    type: 'read',
    name: 'get_inbound_detail',
    description: 'Get inbound detail by ID.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['inboundId'],
      properties: {
        inboundId: { type: 'string', description: 'INB-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('inboundId', INBOUND_ID_REGEX),
  },
  get_shipment_detail: {
    type: 'read',
    name: 'get_shipment_detail',
    description: 'Get shipment detail by ID.',
    requiredPermissions: ['shipping.dispatch', 'orders.view', 'orders.create'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['shipmentId'],
      properties: {
        shipmentId: { type: 'string', description: 'SHP-YYYYMMDD-NNN' },
      },
    },
    parser: readIdSchema('shipmentId', SHIPMENT_ID_REGEX),
  },
  list_customers: {
    type: 'read',
    name: 'list_customers',
    description: 'List customer profiles.',
    requiredPermissions: ['settings.master-data'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['active', 'inactive'] },
        phone: { type: 'string' },
        keyword: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['active', 'inactive']).optional(),
        phone: z.string().trim().regex(/^1\d{10}$/).optional(),
        keyword: keywordSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
  get_customer_detail: {
    type: 'read',
    name: 'get_customer_detail',
    description: 'Get customer detail by id or keyword.',
    requiredPermissions: ['settings.master-data'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string', description: 'CUS-1001' },
        keyword: { type: 'string' },
      },
    },
    parser: z
      .object({
        customerId: z.string().trim().regex(CUSTOMER_ID_REGEX).optional(),
        keyword: keywordSchema,
      })
      .strict()
      .refine((value) => Boolean(value.customerId || value.keyword), { message: 'One of customerId or keyword is required' }),
  },
  get_reports_overview: {
    type: 'read',
    name: 'get_reports_overview',
    description: 'Get reports overview.',
    requiredPermissions: ['reports.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', enum: ['总览', '趋势', '销售', '账龄'] },
      },
    },
    parser: z
      .object({
        topic: z.enum(['总览', '趋势', '销售', '账龄']).optional(),
      })
      .strict(),
  },
  list_audit_logs: {
    type: 'read',
    name: 'list_audit_logs',
    description: 'List audit logs.',
    requiredPermissions: ['settings.access-control'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entityType: { type: 'string' },
        action: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        entityType: keywordSchema,
        action: keywordSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
};

Object.assign(READ_TOOL_SCHEMAS, READ_TOOL_SCHEMAS_PHASE_2);

const READ_TOOL_SCHEMAS_PHASE_3: Partial<Record<ReadOnlyToolName, RuntimeToolSchemaDefinition>> = {
  get_dashboard_overview: {
    type: 'read',
    name: 'get_dashboard_overview',
    description: 'Get dashboard overview KPIs.',
    requiredPermissions: ['reports.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        focus: { type: 'string', enum: ['订单', '发货', '回款', '库存'] },
      },
    },
    parser: z
      .object({
        focus: z.enum(['订单', '发货', '回款', '库存']).optional(),
      })
      .strict(),
  },
  get_inventory_overview: {
    type: 'read',
    name: 'get_inventory_overview',
    description: 'Get inventory overview metrics.',
    requiredPermissions: ['inventory.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['总览', '低库存', '可用库存'] },
      },
    },
    parser: z
      .object({
        scope: z.enum(['总览', '低库存', '可用库存']).optional(),
      })
      .strict(),
  },
  list_inventory_alerts: {
    type: 'read',
    name: 'list_inventory_alerts',
    description: 'List low stock alerts.',
    requiredPermissions: ['inventory.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'string', enum: ['低库存', '缺货'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        level: z.enum(['低库存', '缺货']).optional(),
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_procurement_suggestions: {
    type: 'read',
    name: 'list_procurement_suggestions',
    description: 'List procurement suggestions for shortages.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z.object({ limit: integerLimitSchema }).strict(),
  },
  get_finance_overview: {
    type: 'read',
    name: 'get_finance_overview',
    description: 'Get finance overview for receivable/payable.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['总览', '应收', '应付'] },
      },
    },
    parser: z
      .object({
        scope: z.enum(['总览', '应收', '应付']).optional(),
      })
      .strict(),
  },
  list_receivables: {
    type: 'read',
    name: 'list_receivables',
    description: 'List receivable records.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待收款', '部分收款', '已收款'] },
        overdueOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待收款', '部分收款', '已收款']).optional(),
        overdueOnly: booleanOptionalSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_receipt_records: {
    type: 'read',
    name: 'list_receipt_records',
    description: 'List receipt records.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        dateFrom: dateStringSchema.optional(),
        dateTo: dateStringSchema.optional(),
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_payables: {
    type: 'read',
    name: 'list_payables',
    description: 'List payable records.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待付款', '部分付款', '已付款'] },
        overdueOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待付款', '部分付款', '已付款']).optional(),
        overdueOnly: booleanOptionalSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_payment_records: {
    type: 'read',
    name: 'list_payment_records',
    description: 'List payment records.',
    requiredPermissions: ['finance.view'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        dateFrom: dateStringSchema.optional(),
        dateTo: dateStringSchema.optional(),
        limit: integerLimitSchema,
      })
      .strict(),
  },
  get_customer_summary: {
    type: 'read',
    name: 'get_customer_summary',
    description: 'Get customer summary metrics.',
    requiredPermissions: ['settings.master-data'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['总览', '活跃', '沉默'] },
      },
    },
    parser: z
      .object({
        scope: z.enum(['总览', '活跃', '沉默']).optional(),
      })
      .strict(),
  },
  get_role_template_guide: {
    type: 'read',
    name: 'get_role_template_guide',
    description: 'Query role template guide.',
    requiredPermissions: ['settings.access-control'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string' },
      },
    },
    parser: z.object({ role: keywordSchema }).strict(),
  },
  get_security_level_guide: {
    type: 'read',
    name: 'get_security_level_guide',
    description: 'Query security level guide.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'string', enum: ['低风险', '中风险', '高风险'] },
      },
    },
    parser: z
      .object({
        level: z.enum(['低风险', '中风险', '高风险']).optional(),
      })
      .strict(),
  },
  get_audit_definition: {
    type: 'read',
    name: 'get_audit_definition',
    description: 'Query audit definition.',
    requiredPermissions: ['settings.access-control'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string' },
      },
    },
    parser: z.object({ topic: keywordSchema }).strict(),
  },
  get_report_definitions: {
    type: 'read',
    name: 'get_report_definitions',
    description: 'Query report definitions.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string' },
      },
    },
    parser: z.object({ keyword: keywordSchema }).strict(),
  },
  get_api_catalog: {
    type: 'read',
    name: 'get_api_catalog',
    description: 'Query API catalog.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        moduleId: { type: 'string' },
        keyword: { type: 'string' },
      },
    },
    parser: z.object({ moduleId: keywordSchema, keyword: keywordSchema }).strict(),
  },
  get_database_table_detail: {
    type: 'read',
    name: 'get_database_table_detail',
    description: 'Query database table detail.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tableName: { type: 'string' },
      },
    },
    parser: z.object({ tableName: keywordSchema }).strict(),
  },
  get_access_overview: {
    type: 'read',
    name: 'get_access_overview',
    description: 'Query access overview.',
    requiredPermissions: ['settings.access-control'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string' },
      },
    },
    parser: z.object({ keyword: keywordSchema }).strict(),
  },
  get_master_data_overview: {
    type: 'read',
    name: 'get_master_data_overview',
    description: 'Query master data overview.',
    requiredPermissions: ['settings.master-data'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: { type: 'string', enum: ['商品', '供应商', '仓库'] },
      },
    },
    parser: z
      .object({
        entity: z.enum(['商品', '供应商', '仓库']).optional(),
      })
      .strict(),
  },
  get_password_policy: {
    type: 'read',
    name: 'get_password_policy',
    description: 'Query password policy.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    parser: z.object({}).strict(),
  },
  get_password_security: {
    type: 'read',
    name: 'get_password_security',
    description: 'Query password security status for current user.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeSessions: { type: 'boolean' },
      },
    },
    parser: z.object({ includeSessions: booleanOptionalSchema }).strict(),
  },
  list_user_sessions: {
    type: 'read',
    name: 'list_user_sessions',
    description: 'List current user sessions.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z.object({ limit: integerLimitSchema }).strict(),
  },
  list_arrivals: {
    type: 'read',
    name: 'list_arrivals',
    description: 'List arrivals.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待验收', '部分验收', '已验收'] },
        supplierKeyword: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待验收', '部分验收', '已验收']).optional(),
        supplierKeyword: keywordSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_inbounds: {
    type: 'read',
    name: 'list_inbounds',
    description: 'List inbound orders.',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待入库', '已入库', '已冲销'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待入库', '已入库', '已冲销']).optional(),
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_shipments: {
    type: 'read',
    name: 'list_shipments',
    description: 'List shipments.',
    requiredPermissions: ['shipping.dispatch', 'orders.view', 'orders.create'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['待发货', '已发货', '已完成', '已取消'] },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        status: z.enum(['待发货', '已发货', '已完成', '已取消']).optional(),
        dateFrom: dateStringSchema.optional(),
        dateTo: dateStringSchema.optional(),
        limit: integerLimitSchema,
      })
      .strict(),
  },
  list_system_notifications: {
    type: 'read',
    name: 'list_system_notifications',
    description: 'List notification center messages.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unreadOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        unreadOnly: booleanOptionalSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
  get_profile_memory: {
    type: 'read',
    name: 'get_profile_memory',
    description: 'Get effective profile memory for current scope.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scopeType: { type: 'string', enum: ['global', 'tenant', 'user', 'session'] },
        scopeId: { type: 'string' },
      },
    },
    parser: z
      .object({
        scopeType: profileScopeSchema,
        scopeId: z.string().trim().min(1).max(160).optional(),
      })
      .strict(),
  },
  list_memory_facts: {
    type: 'read',
    name: 'list_memory_facts',
    description: 'List profile/episodic memory facts in current scope.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scopeType: { type: 'string', enum: ['global', 'tenant', 'user', 'session'] },
        scopeId: { type: 'string' },
        includeEpisodic: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    parser: z
      .object({
        scopeType: profileScopeSchema,
        scopeId: z.string().trim().min(1).max(160).optional(),
        includeEpisodic: booleanOptionalSchema,
        limit: integerLimitSchema,
      })
      .strict(),
  },
};

Object.assign(READ_TOOL_SCHEMAS, READ_TOOL_SCHEMAS_PHASE_3);

const WRITE_TOOL_SCHEMAS: Record<RuntimeWriteToolName, RuntimeToolSchemaDefinition> = {
  create_customer_profile: {
    type: 'write',
    name: 'create_customer_profile',
    description: 'Create customer profile (approval required).',
    requiredPermissions: ['settings.master-data'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'channelPreference'],
      properties: {
        name: { type: 'string' },
        channelPreference: { type: 'string' },
        contactName: { type: 'string' },
        phone: { type: 'string' },
      },
    },
    parser: z
      .object({
        name: z.string().trim().min(1),
        channelPreference: z.string().trim().min(1),
        contactName: z.string().trim().optional(),
        phone: z.string().trim().regex(/^1\d{10}$/).optional(),
      })
      .strict(),
  },
  create_product_master_data: {
    type: 'write',
    name: 'create_product_master_data',
    description: 'Create product master data (approval required).',
    requiredPermissions: ['settings.master-data'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sku', 'name', 'salePrice', 'costPrice', 'preferredSupplierName'],
      properties: {
        sku: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
        unit: { type: 'string' },
        safeStock: { type: 'integer', minimum: 0 },
        salePrice: { type: 'number', minimum: 0.01 },
        costPrice: { type: 'number', minimum: 0.01 },
        preferredSupplierName: { type: 'string' },
      },
    },
    parser: z
      .object({
        sku: z.string().trim().min(1),
        name: z.string().trim().min(1),
        category: z.string().trim().optional(),
        unit: z.string().trim().optional(),
        safeStock: z.coerce.number().int().min(0).optional(),
        salePrice: z.coerce.number().gt(0),
        costPrice: z.coerce.number().gt(0),
        preferredSupplierName: z.string().trim().min(1),
      })
      .strict(),
  },
  generate_shortage_procurement: {
    type: 'write',
    name: 'generate_shortage_procurement',
    description: 'Generate replenishment procurement (approval required).',
    requiredPermissions: ['procurement.manage'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    parser: z.object({}).strict(),
  },
  advance_arrival_status: {
    type: 'write',
    name: 'advance_arrival_status',
    description: 'Advance arrival status (approval required).',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['arrivalId'],
      properties: {
        arrivalId: { type: 'string', description: 'RCV-YYYYMMDD-NNN' },
      },
    },
    parser: z.object({ arrivalId: z.string().trim().regex(ARRIVAL_ID_REGEX) }).strict(),
  },
  confirm_inbound: {
    type: 'write',
    name: 'confirm_inbound',
    description: 'Confirm inbound operation (approval required).',
    requiredPermissions: ['procurement.manage'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['inboundId'],
      properties: {
        inboundId: { type: 'string', description: 'INB-YYYYMMDD-NNN' },
      },
    },
    parser: z.object({ inboundId: z.string().trim().regex(INBOUND_ID_REGEX) }).strict(),
  },
  dispatch_shipping: {
    type: 'write',
    name: 'dispatch_shipping',
    description: 'Dispatch shipment (approval required).',
    requiredPermissions: ['shipping.dispatch'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['shipmentId'],
      properties: {
        shipmentId: { type: 'string', description: 'SHP-YYYYMMDD-NNN' },
      },
    },
    parser: z.object({ shipmentId: z.string().trim().regex(SHIPMENT_ID_REGEX) }).strict(),
  },
  register_receipt: {
    type: 'write',
    name: 'register_receipt',
    description: 'Register receipt on receivable (approval required).',
    requiredPermissions: ['finance.receivable'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['receivableId', 'amount'],
      properties: {
        receivableId: { type: 'string', description: 'AR-YYYYMMDD-NNN' },
        amount: { type: 'number', minimum: 0.01 },
        method: { type: 'string' },
        remark: { type: 'string' },
      },
    },
    parser: z
      .object({
        receivableId: z.string().trim().regex(RECEIVABLE_ID_REGEX),
        amount: z.coerce.number().gt(0),
        method: z.string().trim().min(1).optional(),
        remark: z.string().trim().optional(),
      })
      .strict(),
  },
  register_payment: {
    type: 'write',
    name: 'register_payment',
    description: 'Register payment on payable (approval required).',
    requiredPermissions: ['finance.payable'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['payableId', 'amount'],
      properties: {
        payableId: { type: 'string', description: 'AP-YYYYMMDD-NNN' },
        amount: { type: 'number', minimum: 0.01 },
        method: { type: 'string' },
        remark: { type: 'string' },
      },
    },
    parser: z
      .object({
        payableId: z.string().trim().regex(PAYABLE_ID_REGEX),
        amount: z.coerce.number().gt(0),
        method: z.string().trim().min(1).optional(),
        remark: z.string().trim().optional(),
      })
      .strict(),
  },
  create_sales_order: {
    type: 'write',
    name: 'create_sales_order',
    description: 'Create sales order (approval required).',
    requiredPermissions: ['orders.create'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['customerName', 'orderChannel', 'expectedDeliveryDate', 'items'],
      properties: {
        customerName: { type: 'string' },
        orderChannel: { type: 'string' },
        expectedDeliveryDate: { type: 'string', description: 'YYYY-MM-DD' },
        remark: { type: 'string' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sku', 'quantity'],
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    parser: z
      .object({
        customerName: z.string().trim().min(1),
        orderChannel: z.string().trim().min(1),
        expectedDeliveryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
        remark: z.string().trim().optional(),
        items: z
          .array(
            z
              .object({
                sku: z.string().trim().min(1),
                quantity: z.coerce.number().int().min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  },
  update_profile_memory: {
    type: 'write',
    name: 'update_profile_memory',
    description: 'Update long-term profile memory. Low-risk fields apply immediately, high-risk fields require approval.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target', 'newValue'],
      properties: {
        target: {
          type: 'string',
          enum: [
            'assistantDisplayName',
            'assistantAliases',
            'userPreferredName',
            'language',
            'stylePreferences',
            'permissionPolicyNote',
            'financePolicyNote',
            'accountPolicyNote',
          ],
        },
        newValue: { type: 'string' },
        scopeType: { type: 'string', enum: ['global', 'tenant', 'user', 'session'] },
        scopeId: { type: 'string' },
        appendOldValueToAliases: { type: 'boolean' },
        recordEpisodicEvent: { type: 'boolean' },
      },
    },
    parser: z
      .object({
        target: memoryTargetSchema.refine((value) => Boolean(value), { message: 'target is required' }),
        newValue: z.string().trim().min(1),
        scopeType: profileScopeSchema,
        scopeId: z.string().trim().min(1).max(160).optional(),
        appendOldValueToAliases: booleanOptionalSchema,
        recordEpisodicEvent: booleanOptionalSchema,
      })
      .strict(),
  },
  supersede_memory_fact: {
    type: 'write',
    name: 'supersede_memory_fact',
    description: 'Supersede an existing memory fact with a new value.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        factId: { type: 'string' },
        target: {
          type: 'string',
          enum: [
            'assistantDisplayName',
            'assistantAliases',
            'userPreferredName',
            'language',
            'stylePreferences',
            'permissionPolicyNote',
            'financePolicyNote',
            'accountPolicyNote',
          ],
        },
        newValue: { type: 'string' },
        scopeType: { type: 'string', enum: ['global', 'tenant', 'user', 'session'] },
        scopeId: { type: 'string' },
      },
      required: ['newValue'],
    },
    parser: z
      .object({
        factId: z.string().trim().min(1).max(220).optional(),
        target: memoryTargetSchema,
        newValue: z.string().trim().min(1),
        scopeType: profileScopeSchema,
        scopeId: z.string().trim().min(1).max(160).optional(),
      })
      .strict()
      .refine((value) => Boolean(value.factId || value.target), {
        message: 'Either factId or target is required',
      }),
  },
  delete_memory_fact: {
    type: 'write',
    name: 'delete_memory_fact',
    description: 'Delete a memory fact by factId or target.',
    requiredPermissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        factId: { type: 'string' },
        target: {
          type: 'string',
          enum: [
            'assistantDisplayName',
            'assistantAliases',
            'userPreferredName',
            'language',
            'stylePreferences',
            'permissionPolicyNote',
            'financePolicyNote',
            'accountPolicyNote',
          ],
        },
        scopeType: { type: 'string', enum: ['global', 'tenant', 'user', 'session'] },
        scopeId: { type: 'string' },
      },
    },
    parser: z
      .object({
        factId: z.string().trim().min(1).max(220).optional(),
        target: memoryTargetSchema,
        scopeType: profileScopeSchema,
        scopeId: z.string().trim().min(1).max(160).optional(),
      })
      .strict()
      .refine((value) => Boolean(value.factId || value.target), {
        message: 'Either factId or target is required',
      }),
  },
};

function hasAnyPermission(permissions: string[], requiredPermissions: string[]) {
  if (requiredPermissions.length === 0) {
    return true;
  }
  return requiredPermissions.some((permission) => permissions.includes(permission));
}

function readToolDefinition(name: ReadOnlyToolName) {
  const definition = READ_TOOL_SCHEMAS[name];
  if (!definition) {
    throw new Error(`Missing read tool schema: ${name}`);
  }
  return definition;
}

function getRuntimeToolSchema(name: string): RuntimeToolSchemaDefinition | null {
  if (READ_TOOL_NAME_SET.has(name as ReadOnlyToolName)) {
    return readToolDefinition(name as ReadOnlyToolName);
  }
  if (name in WRITE_TOOL_SCHEMAS) {
    return WRITE_TOOL_SCHEMAS[name as RuntimeWriteToolName];
  }
  return null;
}

function parseToolArguments(schema: z.ZodTypeAny, rawArguments: string | undefined) {
  let parsedRaw: unknown = {};
  if (rawArguments && rawArguments.trim()) {
    parsedRaw = JSON.parse(rawArguments);
  }
  return schema.parse(parsedRaw) as Record<string, unknown>;
}

// Removed prompt-based write planner bridge. Write tools now execute via typed pending-action runtime.

function createToolResult(input: Omit<RuntimeToolResult, 'context'> & { context?: string }): RuntimeToolResult {
  return {
    ...input,
    context: input.context || input.summary,
  };
}

function isNoResultSummary(summary: string) {
  const tokens = ['没有匹配', '不存在', '未找到', '当前没有', '没有待处理', '无历史'];
  return tokens.some((token) => summary.includes(token));
}

function toMemoryUpdateData(decision: MemoryUpdateDecision, extra: Record<string, unknown> = {}) {
  return {
    action: decision.action,
    target: decision.target,
    oldValue: decision.oldValue,
    newValue: decision.newValue,
    scopeType: decision.scopeType,
    scopeId: decision.scopeId,
    requiresApproval: decision.requiresApproval,
    auditPayload: decision.auditPayload,
    ...extra,
  };
}

function summarizeMemoryDecision(action: MemoryDecisionAction, target: string) {
  if (action === 'ADD') {
    return `记忆已新增：${target}`;
  }
  if (action === 'UPDATE') {
    return `记忆已更新：${target}`;
  }
  if (action === 'DELETE') {
    return `记忆已删除：${target}`;
  }
  return `记忆无需变更：${target}`;
}

function inferTargetFromFactId(factId: string) {
  if (!factId) {
    return '';
  }
  if (factId.startsWith('profile:')) {
    return factId.replace('profile:', '').trim();
  }
  if (factId.startsWith('sensitive:')) {
    const parts = factId.split(':');
    return parts[1] || '';
  }
  return '';
}

function resolveMemoryArgs(args: Record<string, unknown>, request: RuntimeToolExecutionRequest) {
  return {
    scopeType: typeof args.scopeType === 'string' ? (args.scopeType as 'global' | 'tenant' | 'user' | 'session') : undefined,
    scopeId: typeof args.scopeId === 'string' ? args.scopeId : undefined,
    tenantId: request.tenantId,
    userId: request.userId,
    sessionId: request.sessionId,
  };
}

function executeMemoryWriteTool(
  toolName: MemoryWriteToolName,
  args: Record<string, unknown>,
  request: RuntimeToolExecutionRequest,
): RuntimeToolExecutionResult {
  const memoryArgs = resolveMemoryArgs(args, request);
  const factId = typeof args.factId === 'string' ? args.factId : '';

  let decision: MemoryUpdateDecision | ReturnType<typeof deleteMemoryFactById>;
  if (toolName === 'update_profile_memory') {
    decision = planMemoryUpdate({
      prompt: '',
      userId: request.userId,
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      username: request.username,
      target: typeof args.target === 'string' ? args.target : undefined,
      newValue: typeof args.newValue === 'string' ? args.newValue : undefined,
      scopeType: memoryArgs.scopeType,
      scopeId: memoryArgs.scopeId,
      appendOldValueToAliases: Boolean(args.appendOldValueToAliases),
      deleteMode: false,
    });
  } else if (toolName === 'supersede_memory_fact') {
    const inferredTarget = typeof args.target === 'string' ? args.target : inferTargetFromFactId(factId);
    decision = planMemoryUpdate({
      prompt: '',
      userId: request.userId,
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      username: request.username,
      target: inferredTarget || undefined,
      newValue: typeof args.newValue === 'string' ? args.newValue : undefined,
      scopeType: memoryArgs.scopeType,
      scopeId: memoryArgs.scopeId,
      appendOldValueToAliases: true,
      deleteMode: false,
    });
  } else {
    if (factId) {
      decision = deleteMemoryFactById({
        factId,
        userId: request.userId,
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        username: request.username,
      });
    } else {
      const inferredTarget = typeof args.target === 'string' ? args.target : inferTargetFromFactId(factId);
      decision = planMemoryUpdate({
        prompt: '',
        userId: request.userId,
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        username: request.username,
        target: inferredTarget || undefined,
        scopeType: memoryArgs.scopeType,
        scopeId: memoryArgs.scopeId,
        deleteMode: true,
      });
    }
  }

  const strictDecision = decision as MemoryUpdateDecision;
  if (toolName === 'delete_memory_fact' && factId.startsWith('mem-')) {
    const summary = strictDecision.action === 'DELETE' ? '已删除对话记忆事实。' : '未找到可删除的对话记忆事实。';
    const toolCall: AiToolCallRecord = {
      name: toolName,
      status: 'completed',
      summary,
    };
    return {
      toolCall,
      toolContext: summary,
      result: createToolResult({
        ok: strictDecision.action === 'DELETE',
        code: strictDecision.action === 'DELETE' ? 'ok' : 'no_result',
        message: summary,
        summary,
        data: {
          memoryUpdate: toMemoryUpdateData(strictDecision),
        },
      }),
    };
  }

  if (strictDecision.requiresApproval) {
    if (!request.permissions.includes(MEMORY_HIGH_RISK_PERMISSION)) {
      const summary = `Permission denied. High-risk memory update requires ${MEMORY_HIGH_RISK_PERMISSION}.`;
      const toolCall: AiToolCallRecord = {
        name: toolName,
        status: 'disabled',
        summary,
      };
      return {
        toolCall,
        toolContext: summary,
        result: createToolResult({
          ok: false,
          code: 'permission_denied',
          message: summary,
          summary,
          data: {
            memoryUpdate: toMemoryUpdateData(strictDecision),
          },
        }),
      };
    }

    const actionName =
      toolName === 'delete_memory_fact'
        ? 'delete_memory_fact_sensitive'
        : toolName === 'supersede_memory_fact'
          ? 'supersede_memory_fact_sensitive'
          : 'update_profile_memory_sensitive';
    const planned = planRuntimeWriteAction({
      toolName,
      actionName,
      requiredPermission: MEMORY_HIGH_RISK_PERMISSION,
      payload: {
        target: strictDecision.target,
        newValue: Array.isArray(strictDecision.newValue)
          ? strictDecision.newValue.join(', ')
          : typeof strictDecision.newValue === 'string'
            ? strictDecision.newValue
            : undefined,
        scopeType: strictDecision.scopeType,
        scopeId: strictDecision.scopeId,
        tenantId: request.tenantId,
        userId: request.userId,
        sessionId: request.sessionId,
      },
      summary: `高风险记忆变更待确认：${strictDecision.target} (${strictDecision.action})`,
      confirmationMessage: '这是高风险记忆字段，确认后才会写入。是否继续执行？',
      userId: request.userId,
      username: request.username,
    });
    const { pendingAction, approval, toolCall } = planned;
    const summary = pendingAction.summary;
    return {
      toolCall,
      toolContext: summary,
      pendingAction,
      approval,
      result: createToolResult({
        ok: true,
        code: 'approval_required',
        message: summary,
        summary,
        pendingAction,
        approval,
        data: {
          memoryUpdate: toMemoryUpdateData(strictDecision),
        },
      }),
    };
  }

  const applyResult =
    strictDecision.action === 'NONE'
      ? {
          changed: false,
          summary: summarizeMemoryDecision(strictDecision.action, strictDecision.target),
          profile: getProfileMemory({
            tenantId: request.tenantId,
            userId: request.userId,
            sessionId: request.sessionId,
          }).profile,
        }
      : applyLowRiskMemoryUpdate({
          decision: strictDecision,
          username: request.username,
          appendOldValueToAliases: Boolean(args.appendOldValueToAliases),
          recordEpisodicEvent: args.recordEpisodicEvent !== false,
        });

  const summary = applyResult.summary || summarizeMemoryDecision(strictDecision.action, strictDecision.target);
  const context =
    strictDecision.action === 'NONE'
      ? `记忆无需更新：${strictDecision.target}`
      : `记忆更新完成：${strictDecision.target} (${strictDecision.action})`;
  const toolCall: AiToolCallRecord = {
    name: toolName,
    status: 'completed',
    summary,
  };

  return {
    toolCall,
    toolContext: context,
    result: createToolResult({
      ok: true,
      code: strictDecision.action === 'NONE' ? 'no_result' : 'ok',
      message: summary,
      summary,
      context,
      data: {
        memoryUpdate: toMemoryUpdateData(strictDecision, {
          profile: applyResult.profile,
        }),
      },
    }),
  };
}

function resolveSupersedePendingActionId(
  toolName: RuntimeWriteToolName,
  history: RuntimeToolExecutionRequest['history'],
) {
  if (!Array.isArray(history) || history.length === 0) {
    return undefined;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item || item.pendingActionStatus !== 'pending') {
      continue;
    }
    if (item.pendingActionName === toolName && item.pendingActionId) {
      return item.pendingActionId;
    }
  }
  return undefined;
}

function executeTypedWriteTool(
  toolName: RuntimeWriteToolName,
  args: Record<string, unknown>,
  request: RuntimeToolExecutionRequest,
): RuntimeToolExecutionResult {
  const schema = WRITE_TOOL_SCHEMAS[toolName];
  const requiredPermission = schema?.requiredPermissions?.[0] || '';
  const supersedePendingActionId = resolveSupersedePendingActionId(toolName, request.history);

  let payload: Record<string, unknown>;
  let summary: string;
  let confirmationMessage: string;

  try {
    switch (toolName) {
      case 'create_customer_profile':
        payload = {
          name: String(args.name || '').trim(),
          channelPreference: String(args.channelPreference || '').trim(),
          contactName: typeof args.contactName === 'string' ? args.contactName.trim() : undefined,
          phone: typeof args.phone === 'string' ? args.phone.trim() : undefined,
        };
        summary = `待确认：创建客户档案 ${payload.name || '-'}。`;
        confirmationMessage = `将创建客户档案「${payload.name || '-'}」，确认后执行写入，是否继续？`;
        break;
      case 'create_product_master_data': {
        const supplierName = String(args.preferredSupplierName || '').trim();
        const supplierRef = resolveActiveSupplierReference(supplierName);
        payload = {
          sku: String(args.sku || '').trim().toUpperCase(),
          name: String(args.name || '').trim(),
          category: typeof args.category === 'string' ? args.category.trim() : '综合',
          unit: typeof args.unit === 'string' ? args.unit.trim() : '件',
          safeStock: typeof args.safeStock === 'number' ? Math.max(0, Math.trunc(args.safeStock)) : 0,
          salePrice: Number(args.salePrice || 0),
          costPrice: Number(args.costPrice || 0),
          preferredSupplierId: supplierRef.id,
          preferredSupplierName: supplierRef.name,
        };
        summary = `待确认：创建商品档案 ${payload.sku || '-'} / ${payload.name || '-'}.`;
        confirmationMessage = `将创建商品「${payload.name || '-'}（${payload.sku || '-'}）」并绑定供应商「${payload.preferredSupplierName || '-'}」，确认后写入，是否继续？`;
        break;
      }
      case 'generate_shortage_procurement':
        payload = {
          trigger: 'typed_tool_runtime',
          generatedAt: new Date().toISOString(),
        };
        summary = '待确认：生成补货采购单。';
        confirmationMessage = '将按当前缺货状态自动生成补货采购单，确认后执行，是否继续？';
        break;
      case 'advance_arrival_status': {
        const arrivalId = String(args.arrivalId || '').trim().toUpperCase();
        payload = {
          arrivalId,
          poId: '',
          supplier: '',
          previousStatus: '',
          nextStatus: '',
        };
        summary = `待确认：推进到货单 ${arrivalId} 状态。`;
        confirmationMessage = `将推进到货单「${arrivalId}」到下一状态，确认后执行，是否继续？`;
        break;
      }
      case 'confirm_inbound': {
        const inboundId = String(args.inboundId || '').trim().toUpperCase();
        payload = {
          inboundId,
          receivingNoteId: '',
          supplier: '',
          itemCount: 0,
          warehouse: '',
          previousStatus: '',
        };
        summary = `待确认：确认入库单 ${inboundId}。`;
        confirmationMessage = `将确认入库单「${inboundId}」并执行库存入账，是否继续？`;
        break;
      }
      case 'dispatch_shipping': {
        const shipmentId = String(args.shipmentId || '').trim().toUpperCase();
        payload = {
          deliveryId: shipmentId,
          orderId: '',
          customer: '',
          itemCount: 0,
          stockStatus: '',
          previousStatus: '',
        };
        summary = `待确认：执行发货 ${shipmentId}。`;
        confirmationMessage = `将执行发货单「${shipmentId}」出库与状态更新，确认后执行，是否继续？`;
        break;
      }
      case 'register_receipt': {
        const receivableId = String(args.receivableId || '').trim().toUpperCase();
        const amount = Number(args.amount || 0);
        const method = typeof args.method === 'string' && args.method.trim() ? args.method.trim() : '银行转账';
        payload = {
          receivableId,
          orderId: '',
          customer: '',
          amountDue: 0,
          amountPaidBefore: 0,
          amount,
          remainingAmount: 0,
          projectedAmountPaid: 0,
          projectedRemainingAmount: 0,
          projectedStatus: '',
          method,
          remark: typeof args.remark === 'string' ? args.remark.trim() : undefined,
        };
        summary = `待确认：登记应收 ${receivableId} 收款 ${amount.toFixed(2)} 元。`;
        confirmationMessage = `将对「${receivableId}」登记收款 ${amount.toFixed(2)} 元（${method}），确认后执行，是否继续？`;
        break;
      }
      case 'register_payment': {
        const payableId = String(args.payableId || '').trim().toUpperCase();
        const amount = Number(args.amount || 0);
        const method = typeof args.method === 'string' && args.method.trim() ? args.method.trim() : '对公转账';
        payload = {
          payableId,
          purchaseOrderId: '',
          supplier: '',
          amountDue: 0,
          amountPaidBefore: 0,
          amount,
          remainingAmount: 0,
          projectedAmountPaid: 0,
          projectedRemainingAmount: 0,
          projectedStatus: '',
          method,
          remark: typeof args.remark === 'string' ? args.remark.trim() : undefined,
        };
        summary = `待确认：登记应付 ${payableId} 付款 ${amount.toFixed(2)} 元。`;
        confirmationMessage = `将对「${payableId}」登记付款 ${amount.toFixed(2)} 元（${method}），确认后执行，是否继续？`;
        break;
      }
      case 'create_sales_order': {
        const items = Array.isArray(args.items)
          ? args.items
              .map((item) => {
                if (!item || typeof item !== 'object') {
                  return null;
                }
                const sku = String((item as { sku?: unknown }).sku || '').trim().toUpperCase();
                const quantity = Number((item as { quantity?: unknown }).quantity || 0);
                if (!sku || !Number.isFinite(quantity) || quantity <= 0) {
                  return null;
                }
                const product = db
                  .prepare<{ name: string; salePrice: number }>(
                    "SELECT name, sale_price as salePrice FROM products WHERE sku = ? AND status = 'active'",
                  )
                  .get(sku);
                if (!product) {
                  throw new Error(`Active product not found for SKU ${sku}`);
                }
                return {
                  sku,
                  quantity: Math.trunc(quantity),
                  productName: product.name,
                  unitPrice: Number(product.salePrice || 0),
                };
              })
              .filter(
                (
                  item,
                ): item is {
                  sku: string;
                  quantity: number;
                  productName: string;
                  unitPrice: number;
                } => Boolean(item),
              )
          : [];
        payload = {
          customerName: String(args.customerName || '').trim(),
          orderChannel: String(args.orderChannel || '').trim(),
          expectedDeliveryDate: String(args.expectedDeliveryDate || '').trim(),
          remark: typeof args.remark === 'string' ? args.remark.trim() : undefined,
          items,
        };
        summary = `待确认：创建销售订单（客户 ${payload.customerName || '-'}，明细 ${items.length} 项）。`;
        confirmationMessage = `将创建销售订单（客户「${payload.customerName || '-'}」），确认后执行写入，是否继续？`;
        break;
      }
      default:
        throw new Error(`Unsupported typed write tool: ${toolName}`);
    }
  } catch (error) {
    const summary = error instanceof Error ? error.message : 'write tool payload build failed';
    const toolCall: AiToolCallRecord = {
      name: toolName,
      status: 'disabled',
      summary,
    };
    return {
      toolCall,
      toolContext: summary,
      result: createToolResult({
        ok: false,
        code: /permission/i.test(summary) ? 'permission_denied' : 'execution_error',
        message: summary,
        summary,
      }),
    };
  }

  const planned = planRuntimeWriteAction({
    toolName,
    actionName: toolName,
    requiredPermission,
    payload,
    summary,
    confirmationMessage,
    userId: request.userId,
    username: request.username,
    supersedePendingActionId,
  });
  const { pendingAction, approval, toolCall } = planned;
  return {
    toolCall,
    toolContext: pendingAction.summary,
    pendingAction,
    approval,
    result: createToolResult({
      ok: true,
      code: 'approval_required',
      message: pendingAction.summary,
      summary: pendingAction.summary,
      pendingAction,
      approval,
      data: {
        writeMode: 'typed',
        payload,
      },
    }),
  };
}

export const READ_TOOLS_WITH_FALLBACK_SCHEMA: ReadOnlyToolName[] = READ_ONLY_TOOL_DESCRIPTORS.filter(
  (descriptor) => !READ_TOOL_SCHEMAS[descriptor.name],
).map((descriptor) => descriptor.name);

export function buildModelToolDefinitions(permissions: string[]): DeepSeekToolDefinition[] {
  const readToolDefinitions = READ_ONLY_TOOL_DESCRIPTORS.filter((descriptor) =>
    hasAnyPermission(permissions, descriptor.requiredPermissions),
  ).map((descriptor) => {
    const definition = readToolDefinition(descriptor.name);
    const permissionText =
      descriptor.requiredPermissions.length > 0 ? descriptor.requiredPermissions.join(' or ') : 'authenticated user';
    return {
      type: 'function' as const,
      metadata: {
        access_mode: 'read' as const,
        origin: 'node' as const,
      },
      function: {
        name: descriptor.name,
        description: `${descriptor.description} Permission: ${permissionText}.`,
        parameters: definition.parameters,
      },
    };
  });

  const writeToolDefinitions = (Object.values(WRITE_TOOL_SCHEMAS) as RuntimeToolSchemaDefinition[])
    .filter((definition) => hasAnyPermission(permissions, definition.requiredPermissions))
    .map((definition) => ({
      type: 'function' as const,
      metadata: {
        access_mode: 'write' as const,
        origin: 'node' as const,
      },
      function: {
        name: definition.name,
        description: MEMORY_WRITE_TOOL_NAMES.has(definition.name as MemoryWriteToolName)
          ? `${definition.description} Low-risk updates apply immediately; high-risk fields require approval.`
          : `${definition.description} The call only creates a pending approval action.`,
        parameters: definition.parameters,
      },
    }));

  return [...readToolDefinitions, ...writeToolDefinitions];
}

export function executeRuntimeToolCall(
  toolName: string,
  rawArguments: string | undefined,
  request: RuntimeToolExecutionRequest,
): RuntimeToolExecutionResult {
  const schema = getRuntimeToolSchema(toolName);
  if (!schema) {
    const toolCall: AiToolCallRecord = {
      name: toolName,
      status: 'disabled',
      summary: 'Unknown tool name.',
    };
    const result = createToolResult({
      ok: false,
      code: 'invalid_tool',
      message: 'Tool is not registered.',
      summary: toolCall.summary,
    });
    return {
      toolCall,
      toolContext: result.context,
      result,
    };
  }

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = parseToolArguments(schema.parser, rawArguments);
  } catch (error) {
    const summary = `Tool argument validation failed: ${error instanceof Error ? error.message : 'invalid args'}`;
    const toolCall: AiToolCallRecord = {
      name: toolName,
      status: 'disabled',
      summary,
    };
    const result = createToolResult({
      ok: false,
      code: 'invalid_arguments',
      message: summary,
      summary,
    });
    return {
      toolCall,
      toolContext: result.context,
      result,
    };
  }

  if (!hasAnyPermission(request.permissions, schema.requiredPermissions)) {
    const permissionText =
      schema.requiredPermissions.length > 0 ? schema.requiredPermissions.join(' or ') : 'authenticated user';
    const summary = `Permission denied. Required permission: ${permissionText}.`;
    const toolCall: AiToolCallRecord = {
      name: toolName,
      status: 'disabled',
      summary,
    };
    const result = createToolResult({
      ok: false,
      code: 'permission_denied',
      message: summary,
      summary,
    });
    return {
      toolCall,
      toolContext: result.context,
      result,
    };
  }

  if (schema.type === 'read') {
    const execution = executeTypedReadOnlyTool({
      toolName: toolName as ReadOnlyToolName,
      args: parsedArgs,
      userId: request.userId,
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      username: request.username,
      permissions: request.permissions,
      token: request.token,
    });
    const toolCall = execution.toolCall;
    const context = execution.toolContext || toolCall.summary;
    const noResult = toolCall.status === 'completed' && isNoResultSummary(toolCall.summary);
    const permissionDenied = toolCall.status === 'disabled' && /权限|permission/i.test(toolCall.summary);
    const data = {
      ...(execution.data || {}),
      fallback: execution.usedFallback,
    };
    const result = createToolResult({
      ok: toolCall.status === 'completed',
      code:
        permissionDenied
          ? 'permission_denied'
          : toolCall.status === 'disabled'
            ? 'execution_error'
            : noResult
              ? 'no_result'
              : 'ok',
      message: toolCall.summary,
      summary: toolCall.summary,
      context,
      data,
    });

    return {
      toolCall,
      toolContext: context,
      result,
    };
  }

  if (MEMORY_WRITE_TOOL_NAMES.has(toolName as MemoryWriteToolName)) {
    return executeMemoryWriteTool(toolName as MemoryWriteToolName, parsedArgs, request);
  }

  return executeTypedWriteTool(toolName as RuntimeWriteToolName, parsedArgs, request);
}



