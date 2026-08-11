import { z } from 'zod';

const DateOrDateTimeSchema = z
  .string()
  .trim()
  .refine((value) => isValidDateOnly(value) || !Number.isNaN(Date.parse(value)), {
    message: 'Expected YYYY-MM-DD or an ISO date-time',
  });

export const AccountingExportQuerySchema = z
  .object({
    from: DateOrDateTimeSchema.optional(),
    to: DateOrDateTimeSchema.optional(),
    format: z.enum(['csv']).optional().default('csv'),
  })
  .refine(
    (value) => {
      if (!value.from || !value.to) {
        return true;
      }
      return dateBound(value.from, 'from') <= dateBound(value.to, 'to');
    },
    { message: 'from must be before or equal to to' },
  );

export type AccountingExportQuery = z.output<typeof AccountingExportQuerySchema>;

function isValidDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function dateBound(value: string, bound: 'from' | 'to') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return bound === 'from'
      ? new Date(`${value}T00:00:00.000Z`).getTime()
      : new Date(`${value}T23:59:59.999Z`).getTime();
  }
  return new Date(value).getTime();
}
