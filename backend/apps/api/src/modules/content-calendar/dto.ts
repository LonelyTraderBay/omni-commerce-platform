import { z } from 'zod';

export const ContentCalendarStatusSchema = z.enum([
  'idea',
  'scheduled',
  'posted',
  'cancelled',
]);

const NullableTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

export const ListContentCalendarQuerySchema = z.object({
  status: ContentCalendarStatusSchema.optional(),
});

export const CreateContentCalendarItemBodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: NullableTextSchema(10_000),
  plannedAt: z.string().datetime(),
  status: ContentCalendarStatusSchema.default('idea'),
  channelHint: NullableTextSchema(120),
  autoPostEnabled: z.boolean().default(false),
});

export const UpdateContentCalendarItemBodySchema =
  CreateContentCalendarItemBodySchema.partial().refine(
    (body) => Object.keys(body).length > 0,
    { message: 'At least one field is required' },
  );

export type ContentCalendarStatus = z.output<
  typeof ContentCalendarStatusSchema
>;
export type ListContentCalendarQuery = z.output<
  typeof ListContentCalendarQuerySchema
>;
export type CreateContentCalendarItemBody = z.output<
  typeof CreateContentCalendarItemBodySchema
>;
export type UpdateContentCalendarItemBody = z.output<
  typeof UpdateContentCalendarItemBodySchema
>;
