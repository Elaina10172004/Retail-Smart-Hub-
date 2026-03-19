import { z } from 'zod';

const requiredText = (field: string) => z.string().trim().min(1, `${field} is required`);

export const sensitiveVerifySchema = z.object({
  verifyPassword: requiredText('verifyPassword'),
});

export const createUserSchema = z.object({
  username: requiredText('username'),
  email: requiredText('email'),
  phone: z.string().optional(),
  department: requiredText('department'),
  roleId: requiredText('roleId'),
});

export const resetUserPasswordSchema = z.object({
  newPassword: requiredText('newPassword'),
});

export const updateUserRoleSchema = z.object({
  roleId: requiredText('roleId'),
});

export const createRoleSchema = z.object({
  name: requiredText('name'),
  description: z.string().optional(),
  scope: requiredText('scope'),
  templateRoleId: z.string().optional(),
});

export const updateRolePermissionsSchema = z.object({
  permissionCodes: z.array(z.string()),
});

export const createSupplierSchema = z.object({
  name: requiredText('name'),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  leadTimeDays: z.coerce.number().int().positive(),
});

export const updateSupplierSchema = createSupplierSchema;

export const createWarehouseSchema = z.object({
  name: requiredText('name'),
  locationCode: requiredText('locationCode'),
  capacity: z.coerce.number().int().positive(),
});

export const updateWarehouseSchema = createWarehouseSchema;

export const createProductSchema = z.object({
  sku: requiredText('sku'),
  name: requiredText('name'),
  category: requiredText('category'),
  unit: requiredText('unit'),
  safeStock: z.coerce.number().int().min(0),
  salePrice: z.coerce.number().positive(),
  costPrice: z.coerce.number().positive(),
  preferredSupplierId: requiredText('preferredSupplierId'),
});

export const updateProductSchema = createProductSchema;

export const importProductsSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
});
