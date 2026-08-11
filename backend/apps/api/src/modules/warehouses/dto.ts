import { z } from 'zod';

export const CreateWarehouseBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .transform((value) => value.toUpperCase()),
  isDefault: z.boolean().optional().default(false),
});

export const TransferStockBodySchema = z.object({
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  variantId: z.string().uuid(),
  qty: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});

export type CreateWarehouseBody = z.output<typeof CreateWarehouseBodySchema>;
export type TransferStockBody = z.output<typeof TransferStockBodySchema>;
