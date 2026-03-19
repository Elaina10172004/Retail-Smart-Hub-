export type ModuleStatus = 'ui-shell' | 'api-skeleton' | 'planned';

export interface ModuleCatalogEntry {
  id: string;
  label: string;
  description: string;
  status: ModuleStatus;
  apiPrefix: string;
}

export const moduleCatalog: ModuleCatalogEntry[] = [
  {
    id: 'dashboard',
    label: '仪表盘',
    description: '聚合展示订单、库存、采购和风险摘要。',
    status: 'api-skeleton',
    apiPrefix: '/api/dashboard',
  },
  {
    id: 'orders',
    label: '客户订单管理',
    description: '订单录入、审核、缺货判断和发货联动。',
    status: 'api-skeleton',
    apiPrefix: '/api/orders',
  },
  {
    id: 'customers',
    label: '客户档案',
    description: '客户主数据、客户贡献和订单归档关系。',
    status: 'api-skeleton',
    apiPrefix: '/api/customers',
  },
  {
    id: 'inventory',
    label: '库存管理',
    description: '库存台账、预警、盘点和安全库存管理。',
    status: 'api-skeleton',
    apiPrefix: '/api/inventory',
  },
  {
    id: 'procurement',
    label: '采购管理',
    description: '采购申请、采购单、到货和补货建议联动。',
    status: 'api-skeleton',
    apiPrefix: '/api/procurement',
  },
  {
    id: 'arrival',
    label: '到货验收',
    description: '供应商到货登记、差异记录和验收结论。',
    status: 'api-skeleton',
    apiPrefix: '/api/arrival',
  },
  {
    id: 'inbound',
    label: '入库管理',
    description: '入库单生成、库存增加和库位更新。',
    status: 'api-skeleton',
    apiPrefix: '/api/inbound',
  },
  {
    id: 'shipping',
    label: '销售发货',
    description: '发货单、拣货、出库和客户履约跟踪。',
    status: 'api-skeleton',
    apiPrefix: '/api/shipping',
  },
  {
    id: 'finance',
    label: '财务管理',
    description: '应收、应付、收款和付款记录。',
    status: 'api-skeleton',
    apiPrefix: '/api/finance',
  },
  {
    id: 'reports',
    label: '报表分析',
    description: '销售、库存、采购和财务统计分析。',
    status: 'api-skeleton',
    apiPrefix: '/api/reports',
  },
  {
    id: 'ai',
    label: 'AI 智能助手',
    description: '规则问答、需求预测、补货建议和对话式操作。',
    status: 'api-skeleton',
    apiPrefix: '/api/ai',
  },
  {
    id: 'config',
    label: '配置管理',
    description: '集中管理 AI 记忆与模型接入参数。',
    status: 'api-skeleton',
    apiPrefix: '/api/ai',
  },
  {
    id: 'settings',
    label: '系统设置',
    description: '系统参数、角色权限和运行配置。',
    status: 'api-skeleton',
    apiPrefix: '/api/settings',
  },
];

export function getModuleCatalogEntry(id: string) {
  return moduleCatalog.find((item) => item.id === id);
}
