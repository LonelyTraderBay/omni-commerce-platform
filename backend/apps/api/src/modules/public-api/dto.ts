import { z } from 'zod';

import { OrderStatusSchema } from '../orders/dto';

export const ApiKeyScopeSchema = z.enum(['orders.read']);

export const CreateApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(ApiKeyScopeSchema).min(1).max(10).default(['orders.read']),
});

export const ListPublicOrdersQuerySchema = z.object({
  status: OrderStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const WebhookEventSchema = z.enum([
  'order.created',
  'order.updated',
  'order.confirmed',
  'order.cancelled',
  'order.shipped',
  'order.done',
  'order.returned',
  'webhook.test',
]);

export const CreateOutboundWebhookBodySchema = z.object({
  url: z.string().trim().url().startsWith('https://').max(2048),
  events: z.array(WebhookEventSchema).min(1).max(20),
  secret: z.string().min(16).max(200).optional(),
  enabled: z.boolean().default(true),
});

export const UpdateOutboundWebhookBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    events: z.array(WebhookEventSchema).min(1).max(20).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });

export type ApiKeyScope = z.output<typeof ApiKeyScopeSchema>;
export type CreateApiKeyBody = z.output<typeof CreateApiKeyBodySchema>;
export type ListPublicOrdersQuery = z.output<typeof ListPublicOrdersQuerySchema>;
export type CreateOutboundWebhookBody = z.output<
  typeof CreateOutboundWebhookBodySchema
>;
export type UpdateOutboundWebhookBody = z.output<
  typeof UpdateOutboundWebhookBodySchema
>;
