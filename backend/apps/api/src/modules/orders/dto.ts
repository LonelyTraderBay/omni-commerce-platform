import { z } from 'zod';

const JsonObjectSchema = z.record(z.string(), z.unknown());
const PaymentMethodSchema = z.enum(['cod', 'bank_transfer', 'other']);
const AttributionTextSchema = z.string().trim().min(1).max(512);
export const OrderStatusSchema = z.enum([
  'draft',
  'confirmed',
  'shipped',
  'done',
  'cancelled',
  'returned',
]);
const PhoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{1,14}$/, 'Expected an E.164 phone number');

export const CreateDraftOrderBodySchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  paymentMethod: PaymentMethodSchema.default('cod'),
  customerName: z.string().trim().min(1).max(256).nullable().optional(),
  phoneE164: PhoneE164Schema.nullable().optional(),
  addressText: z.string().trim().min(1).max(2_000).nullable().optional(),
  addressJson: JsonObjectSchema.default({}),
  utmSource: AttributionTextSchema.nullable().optional(),
  utmMedium: AttributionTextSchema.nullable().optional(),
  utmCampaign: AttributionTextSchema.nullable().optional(),
  clickId: AttributionTextSchema.nullable().optional(),
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        qty: z.number().int().min(1).max(999),
      }),
    )
    .min(1)
    .max(50),
});

export const ListOrdersQuerySchema = z.object({
  status: OrderStatusSchema.optional(),
});

export const ExportOrdersQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  status: OrderStatusSchema.optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
});

export const ReturnOrderBodySchema = z
  .object({
    reason: z.string().trim().max(2_000).nullable().optional(),
    restock: z.boolean().default(true),
  })
  .default({ restock: true });

export type CreateDraftOrderBody = z.output<typeof CreateDraftOrderBodySchema>;
export type ListOrdersQuery = z.output<typeof ListOrdersQuerySchema>;
export type ExportOrdersQuery = z.output<typeof ExportOrdersQuerySchema>;
export type ReturnOrderBody = z.output<typeof ReturnOrderBodySchema>;
export type OrderStatus = z.output<typeof OrderStatusSchema>;
