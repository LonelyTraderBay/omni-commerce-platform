import { z } from 'zod';

export const AdjustStockBodySchema = z.object({
  variantId: z.string().uuid(),
  qtyDelta: z.number().int().refine((value) => value !== 0, {
    message: 'qtyDelta must be non-zero',
  }),
  reason: z.string().trim().max(500).optional(),
  movementType: z.enum(['adjust', 'inbound', 'outbound']).default('adjust'),
});

export const ListMovementsQuerySchema = z.object({
  variantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const LowStockQuerySchema = z.object({
  threshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export type AdjustStockBody = z.output<typeof AdjustStockBodySchema>;
export type ListMovementsQuery = z.output<typeof ListMovementsQuerySchema>;
export type LowStockQuery = z.output<typeof LowStockQuerySchema>;
