import type { Response } from 'express';

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
  code?: string;
  details?: unknown;
  timestamp: string;
}

export function ok<T>(res: Response, data: T, message?: string) {
  const payload: ApiEnvelope<T> = {
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  };

  return res.json(payload);
}

export function fail(res: Response, status: number, message: string, code?: string, details?: unknown) {
  return res.status(status).json({
    success: false,
    message,
    code,
    details,
    timestamp: new Date().toISOString(),
  });
}
