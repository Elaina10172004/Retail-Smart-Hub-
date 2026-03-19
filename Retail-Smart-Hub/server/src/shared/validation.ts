import { z, type ZodType } from 'zod';
import { ApiError } from './api-error';

function buildZodErrorMessage(error: z.ZodError) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'payload';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseWithSchema<T>(schema: ZodType<T>, data: unknown, label = '请求参数') {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(400, `${label}校验失败：${buildZodErrorMessage(parsed.error)}`, 'VALIDATION_ERROR', parsed.error.issues);
  }

  return parsed.data;
}
