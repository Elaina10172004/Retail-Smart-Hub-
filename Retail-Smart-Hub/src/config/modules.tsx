import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  BarChart3,
  Bot,
  CreditCard,
  LayoutDashboard,
  Package,
  Send,
  SlidersHorizontal,
  Settings,
  ShoppingCart,
  Truck,
  Users,
} from 'lucide-react';
import { AIAssistant } from '@/pages/AIAssistant';
import { ConfigManagement } from '@/pages/ConfigManagement';
import { CustomerProfiles } from '@/pages/CustomerProfiles';
import { Dashboard } from '@/pages/Dashboard';
import { FinancialManagement } from '@/pages/FinancialManagement';
import { InboundManagement } from '@/pages/InboundManagement';
import { InventoryManagement } from '@/pages/InventoryManagement';
import { OrderManagement } from '@/pages/OrderManagement';
import { ProcurementManagement } from '@/pages/ProcurementManagement';
import { ReportAnalysis } from '@/pages/ReportAnalysis';
import { SalesShipping } from '@/pages/SalesShipping';
import { SystemAdmin } from '@/pages/SystemAdmin';

export type AppModuleId =
  | 'dashboard'
  | 'orders'
  | 'customers'
  | 'inventory'
  | 'procurement'
  | 'arrival'
  | 'inbound'
  | 'shipping'
  | 'finance'
  | 'reports'
  | 'ai'
  | 'config'
  | 'settings';

export interface AppModuleDefinition {
  id: AppModuleId;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
}

export const appModules: AppModuleDefinition[] = [
  { id: 'dashboard', label: '仪表盘', icon: LayoutDashboard, component: Dashboard },
  { id: 'orders', label: '客户订单管理', icon: ShoppingCart, component: OrderManagement },
  { id: 'customers', label: '客户档案', icon: Users, component: CustomerProfiles },
  { id: 'inventory', label: '库存管理', icon: Package, component: InventoryManagement },
  { id: 'procurement', label: '采购管理', icon: Truck, component: ProcurementManagement },
  { id: 'inbound', label: '到货与入库', icon: Archive, component: InboundManagement },
  { id: 'shipping', label: '销售发货', icon: Send, component: SalesShipping },
  { id: 'finance', label: '财务管理', icon: CreditCard, component: FinancialManagement },
  { id: 'reports', label: '报表分析', icon: BarChart3, component: ReportAnalysis },
  { id: 'ai', label: 'AI 智能助手', icon: Bot, component: AIAssistant },
  { id: 'config', label: '配置管理', icon: SlidersHorizontal, component: ConfigManagement },
  { id: 'settings', label: '系统设置', icon: Settings, component: SystemAdmin },
];

export const defaultModuleId: AppModuleId = 'dashboard';

export function findModuleById(id: string) {
  return appModules.find((item) => item.id === id);
}

function hasAnyPermission(permissions: string[], requiredPermissions: string[]) {
  return requiredPermissions.some((permission) => permissions.includes(permission));
}

export function canAccessModule(moduleId: AppModuleId, permissions: string[]) {
  switch (moduleId) {
    case 'orders':
      return hasAnyPermission(permissions, ['orders.view', 'orders.create']);
    case 'customers':
      return hasAnyPermission(permissions, ['settings.master-data']);
    case 'inventory':
      return hasAnyPermission(permissions, ['inventory.view']);
    case 'procurement':
    case 'arrival':
    case 'inbound':
      return hasAnyPermission(permissions, ['procurement.manage']);
    case 'shipping':
      return hasAnyPermission(permissions, ['shipping.dispatch']);
    case 'finance':
      return hasAnyPermission(permissions, ['finance.view']);
    case 'reports':
      return hasAnyPermission(permissions, ['reports.view']);
    case 'config':
      return hasAnyPermission(permissions, ['settings.access-control']);
    case 'settings':
      return true;
    default:
      return true;
  }
}

export function filterModulesByPermissions(permissions: string[]) {
  return appModules.filter((item) => canAccessModule(item.id, permissions));
}
