import { Router } from 'express';
import { requirePermission } from '../../shared/auth';
import { getModuleCatalogEntry } from '../../shared/module-catalog';
import { ok } from '../../shared/response';
import { getReportOverview } from './reports.service';

export const reportsRouter = Router();

reportsRouter.get('/summary', requirePermission('reports.view'), (_req, res) => {
  return ok(res, {
    module: getModuleCatalogEntry('reports'),
    summary: {
      existingUi: ['销售趋势图', '品类占比图', '库存周转图', '账龄分析表'],
      plannedEntities: ['sales_order', 'inventory', 'receivable', 'payable'],
      nextMilestones: ['补导出接口', '补自定义筛选口径', '补门店维度经营分析'],
    },
  });
});

reportsRouter.get('/overview', requirePermission('reports.view'), (_req, res) => {
  return ok(res, getReportOverview());
});
