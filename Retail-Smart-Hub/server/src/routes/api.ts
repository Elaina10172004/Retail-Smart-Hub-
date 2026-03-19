import { Router } from 'express';
import { aiRouter } from '../modules/ai/ai.routes';
import { agentInternalRouter } from '../modules/ai/agent-internal.routes';
import { arrivalRouter } from '../modules/arrival/arrival.routes';
import { customersRouter } from '../modules/customers/customers.routes';
import { dashboardRouter } from '../modules/dashboard/dashboard.routes';
import { financeRouter } from '../modules/finance/finance.routes';
import { inboundRouter } from '../modules/inbound/inbound.routes';
import { inventoryRouter } from '../modules/inventory/inventory.routes';
import { ordersRouter } from '../modules/orders/orders.routes';
import { procurementRouter } from '../modules/procurement/procurement.routes';
import { reportsRouter } from '../modules/reports/reports.routes';
import { settingsRouter } from '../modules/settings/settings.routes';
import { shippingRouter } from '../modules/shipping/shipping.routes';
import { systemRouter } from '../modules/system/system.routes';
import { env } from '../config/env';
import { requireAuth } from '../shared/auth';
import { ok } from '../shared/response';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  return ok(res, {
    service: 'retail-smart-hub-api',
    status: 'ok',
    environment: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

apiRouter.use('/internal/agent', agentInternalRouter);

apiRouter.use('/system', systemRouter);
apiRouter.use(requireAuth);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/inventory', inventoryRouter);
apiRouter.use('/procurement', procurementRouter);
apiRouter.use('/arrival', arrivalRouter);
apiRouter.use('/inbound', inboundRouter);
apiRouter.use('/shipping', shippingRouter);
apiRouter.use('/finance', financeRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/settings', settingsRouter);

