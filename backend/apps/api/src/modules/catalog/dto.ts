import { z } from 'zod';

const JsonObjectSchema = z.record(z.string(), z.unknown());
const StatusSchema = z.enum(['active', 'archived']);
const VndAmountSchema = z
  .union([
    z.string().regex(/^\d+$/, 'Expected a whole number of VND'),
    z.number().int().nonnegative().safe(),
  ])
  .transform((value) => value.toString())
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: 'Expected a PostgreSQL bigint-compatible VND amount',
  });

export const CreateVariantBodySchema = z.object({
  sku: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(256),
  priceVnd: VndAmountSchema,
  stockQty: z.number().int().min(0).default(0),
  cogsVnd: VndAmountSchema.default('0'),
  attrs: JsonObjectSchema.default({}),
});

export const UpdateVariantBodySchema = z
  .object({
    sku: z.string().trim().min(1).max(128).optional(),
    title: z.string().trim().min(1).max(256).optional(),
    priceVnd: VndAmountSchema.optional(),
    stockQty: z.number().int().min(0).optional(),
    cogsVnd: VndAmountSchema.optional(),
    attrs: JsonObjectSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export const CreateProductBodySchema = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().max(10_000).nullable().optional(),
  status: StatusSchema.default('active'),
  attrs: JsonObjectSchema.default({}),
  variants: z.array(CreateVariantBodySchema).default([]),
});

export const UpdateProductBodySchema = z
  .object({
    title: z.string().trim().min(1).max(256).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    status: StatusSchema.optional(),
    attrs: JsonObjectSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export type CreateProductBody = z.output<typeof CreateProductBodySchema>;
export type UpdateProductBody = z.output<typeof UpdateProductBodySchema>;
export type CreateVariantBody = z.output<typeof CreateVariantBodySchema>;
export type UpdateVariantBody = z.output<typeof UpdateVariantBodySchema>;
