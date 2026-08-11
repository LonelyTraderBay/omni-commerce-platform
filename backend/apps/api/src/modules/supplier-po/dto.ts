import { z } from 'zod';

const MoneyStringSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Expected a non-negative integer VND string');

export const CreateSupplierBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  taxCode: z.string().trim().min(1).max(64).optional(),
  email: z.string().trim().email().max(255).optional(),
  phone: z.string().trim().min(1).max(64).optional(),
  addressText: z.string().trim().min(1).max(500).optional(),
});

export const PurchaseOrderStatusSchema = z.enum([
  'draft',
  'ordered',
  'received',
  'cancelled',
]);

export const PurchaseOrderItemBodySchema = z.object({
  variantId: z.string().uuid(),
  qty: z.number().int().positive(),
  unitCostVnd: MoneyStringSchema,
});

export const CreatePurchaseOrderBodySchema = z.object({
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(),
  status: PurchaseOrderStatusSchema.optional().default('draft'),
  note: z.string().trim().max(500).optional(),
  items: z.array(PurchaseOrderItemBodySchema).min(1).max(200),
});

export const UpdatePurchaseOrderStatusBodySchema = z.object({
  status: z.enum(['ordered', 'cancelled']),
});

export const ReceivePurchaseOrderBodySchema = z.object({
  warehouseId: z.string().uuid(),
});

export type CreateSupplierBody = z.output<typeof CreateSupplierBodySchema>;
export type CreatePurchaseOrderBody = z.output<
  typeof CreatePurchaseOrderBodySchema
>;
export type UpdatePurchaseOrderStatusBody = z.output<
  typeof UpdatePurchaseOrderStatusBodySchema
>;
export type ReceivePurchaseOrderBody = z.output<
  typeof ReceivePurchaseOrderBodySchema
>;
export type PurchaseOrderStatus = z.output<typeof PurchaseOrderStatusSchema>;
