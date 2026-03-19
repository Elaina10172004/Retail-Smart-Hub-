import { Router } from 'express';
import { getModuleCatalogEntry } from './module-catalog';
import { ok } from './response';

interface ModuleSummary {
  existingUi: string[];
  plannedEntities: string[];
  nextMilestones: string[];
}

export function createModuleRouter(moduleId: string, summary: ModuleSummary) {
  const router = Router();

  router.get('/summary', (_req, res) => {
    return ok(res, {
      module: getModuleCatalogEntry(moduleId),
      summary,
    });
  });

  return router;
}
