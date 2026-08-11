import { z } from 'zod';

export const ShippingProviderSchema = z.enum(['manual', 'ghn']);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const UpsertCarrierConnectionBodySchema = z
  .object({
    provider: ShippingProviderSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    credentials: JsonObjectSchema.optional(),
    config: JsonObjectSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const CreateShipmentBodySchema = z
  .object({
    orderId: z.string().uuid(),
    carrierConnectionId: z.string().uuid().optional(),
    provider: ShippingProviderSchema.default('manual'),
  })
  .strict();

export const ListShipmentsQuerySchema = z.object({
  orderId: z.string().uuid(),
});

export type ShippingProviderBody = z.output<typeof ShippingProviderSchema>;
export type UpsertCarrierConnectionBody = z.output<
  typeof UpsertCarrierConnectionBodySchema
>;
export type CreateShipmentBody = z.output<typeof CreateShipmentBodySchema>;
export type ListShipmentsQuery = z.output<typeof ListShipmentsQuerySchema>;
