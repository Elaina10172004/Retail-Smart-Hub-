import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './config/env';
import { apiRouter } from './routes/api';
import { isApiError } from './shared/api-error';
import { fail } from './shared/response';
import { ensurePythonSidecarStarted, stopPythonSidecar } from './modules/ai/python-sidecar.service';

let shutdownHooksRegistered = false;

function registerShutdownHooks() {
  if (shutdownHooksRegistered) {
    return;
  }
  shutdownHooksRegistered = true;

  const teardown = () => {
    stopPythonSidecar();
  };
  process.once('SIGINT', teardown);
  process.once('SIGTERM', teardown);
  process.once('exit', teardown);
}

function buildCorsOriginMatcher(origins: string[]) {
  const allowList = new Set(origins.map((origin) => origin.toLowerCase()));
  return (origin: string) => allowList.has(origin.toLowerCase());
}

export function createApp() {
  void ensurePythonSidecarStarted().catch((error) => {
    console.error(`[python-agent] failed to start sidecar: ${error instanceof Error ? error.message : String(error)}`);
  });
  registerShutdownHooks();

  const app = express();
  const isCorsOriginAllowed = buildCorsOriginMatcher(env.corsOrigins);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowNullOrigin = origin === 'null' && env.corsAllowNullOrigin;
    const allowExplicitOrigin = origin ? isCorsOriginAllowed(origin) : false;

    if (origin && !allowNullOrigin && !allowExplicitOrigin) {
      return fail(res, 403, 'CORS origin is not allowed');
    }

    if (allowNullOrigin) {
      res.header('Access-Control-Allow-Origin', 'null');
      res.header('Vary', 'Origin');
    } else if (allowExplicitOrigin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }

    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });

  app.use('/api', apiRouter);

  app.get('/', (_req, res) => {
    res.redirect('/api/health');
  });

  app.use((req: Request, res: Response) => {
    return fail(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (isApiError(error)) {
      return fail(res, error.status, error.message, error.code, error.details);
    }

    console.error(error);
    return fail(res, 500, error.message || 'Internal server error', 'INTERNAL_ERROR');
  });

  return app;
}
