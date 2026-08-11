import { z } from 'zod';

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const AttributionSummaryQuerySchema = z.object({
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
});

export type AttributionSummaryQuery = z.output<
  typeof AttributionSummaryQuerySchema
>;
