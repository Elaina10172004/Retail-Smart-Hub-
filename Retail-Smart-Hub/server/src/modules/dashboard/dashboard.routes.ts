import { Router } from 'express';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { ok } from '../../shared/response';
import { getDashboardOverview } from './dashboard.service';

export const dashboardRouter = Router();

dashboardRouter.get('/summary', (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('dashboard'),
    summary: {
      existingUi: ['KPI 卡片', '销售趋势图', '库存预警列表', 'AI 补货摘要'],
      plannedEntities: ['sales_order', 'inventory', 'purchase_order', 'replenishment_recommendation'],
      nextMilestones: ['补自定义时间筛选', '补经营环比指标', '补待办跳转联动'],
    },
  });
});

dashboardRouter.get('/overview', (_req, res) => {
  return ok(res, getDashboardOverview());
});
