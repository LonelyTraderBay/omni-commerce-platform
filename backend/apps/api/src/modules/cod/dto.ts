import { z } from 'zod';

const VndStringSchema = z.string().regex(/^\d+$/, {
  message: 'Must be a non-negative integer VND amount',
});

export const CodCollectionSourceSchema = z.enum([
  'manual',
  'carrier_file',
  'carrier_api',
]);

export const RecordCodCollectionBodySchema = z
  .object({
    orderId: z.string().uuid(),
    amountVnd: VndStringSchema,
    collectedAt: z.string().datetime().optional(),
    source: CodCollectionSourceSchema.default('manual'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const ReconcileCodOrderBodySchema = z
  .object({
    orderId: z.string().uuid(),
  })
  .strict();

export const ReconcileCodBatchBodySchema = z
  .object({
    orderIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export type RecordCodCollectionBody = z.output<
  typeof RecordCodCollectionBodySchema
>;
export type ReconcileCodOrderBody = z.output<typeof ReconcileCodOrderBodySchema>;
export type ReconcileCodBatchBody = z.output<typeof ReconcileCodBatchBodySchema>;
