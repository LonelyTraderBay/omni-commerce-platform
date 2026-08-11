import { z } from 'zod';

export const AdSpendSourceSchema = z.enum(['meta_ads', 'csv']);

const DateOnlySchema = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'Expected YYYY-MM-DD',
  })
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: 'Expected a valid calendar date',
  });

const MoneyVndSchema = z
  .union([z.string().trim(), z.number().int().nonnegative()])
  .transform((value, ctx) => {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'amount_vnd must be a safe integer',
        });
        return z.NEVER;
      }
      return String(value);
    }

    if (!/^\d+$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount_vnd must be a non-negative integer VND value',
      });
      return z.NEVER;
    }

    return value;
  });

export const AdSpendRowInputSchema = z
  .object({
    date: DateOnlySchema,
    campaignName: z.string().trim().min(1).max(300).optional(),
    campaign: z.string().trim().min(1).max(300).optional(),
    campaign_name: z.string().trim().min(1).max(300).optional(),
    amountVnd: MoneyVndSchema.optional(),
    amount_vnd: MoneyVndSchema.optional(),
    source: AdSpendSourceSchema.default('csv'),
    externalId: z.string().trim().min(1).max(255).nullable().optional(),
    external_id: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .transform((row, ctx) => {
    const campaignName = row.campaignName ?? row.campaign ?? row.campaign_name;
    if (!campaignName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'campaign is required',
        path: ['campaign'],
      });
      return z.NEVER;
    }

    const amountVnd = row.amountVnd ?? row.amount_vnd;
    if (amountVnd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount_vnd is required',
        path: ['amount_vnd'],
      });
      return z.NEVER;
    }

    return {
      date: row.date,
      campaignName,
      amountVnd,
      source: row.source,
      externalId: row.externalId ?? row.external_id ?? null,
    };
  });

export const ImportAdSpendBodySchema = z
  .object({
    csv: z.string().optional(),
    source: AdSpendSourceSchema.default('csv'),
    rows: z.array(AdSpendRowInputSchema).max(1000).optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.csv?.trim() && (!body.rows || body.rows.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'csv or rows is required',
      });
    }
  });

const DateRangeQueryBaseSchema = z.object({
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
});

const ValidDateRangeSchema = DateRangeQueryBaseSchema.refine(
  (value) => {
    if (!value.from || !value.to) {
      return true;
    }
    return value.from <= value.to;
  },
  { message: 'from must be before or equal to to' },
);

export const ListAdSpendQuerySchema = ValidDateRangeSchema.and(
  z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
);

export const AdSpendSummaryQuerySchema = ValidDateRangeSchema;

export type ImportAdSpendBody = z.output<typeof ImportAdSpendBodySchema>;
export type AdSpendRowInput = z.output<typeof AdSpendRowInputSchema>;
export type ListAdSpendQuery = z.output<typeof ListAdSpendQuerySchema>;
export type AdSpendSummaryQuery = z.output<typeof AdSpendSummaryQuerySchema>;
