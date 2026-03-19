import { z } from 'zod';

const requiredText = (field: string) => z.string().trim().min(1, `${field} is required`);

export const verifyPasswordSchema = z.object({
  verifyPassword: requiredText('verifyPassword'),
});

export const loginPayloadSchema = z.object({
  username: requiredText('username'),
  password: requiredText('password'),
});

export const recoverPasswordRequestSchema = z.object({
  username: requiredText('username'),
  email: requiredText('email'),
  phone: z.string().optional(),
});

export const recoverPasswordConfirmSchema = z.object({
  resetToken: requiredText('resetToken'),
  newPassword: requiredText('newPassword'),
});

export const changePasswordSchema = z.object({
  currentPassword: requiredText('currentPassword'),
  newPassword: requiredText('newPassword'),
});

export const updateProfileSchema = z.object({
  email: requiredText('email'),
  department: requiredText('department'),
  phone: z.string().optional(),
});

export const revokeSessionParamsSchema = z.object({
  sessionId: requiredText('sessionId'),
});
