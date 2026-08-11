import { z } from 'zod';

export const EinvoiceProviderSchema = z.enum(['stub', 'http_sandbox']);
export const EinvoiceJobStatusSchema = z.enum([
  'pending',
  'sent',
  'failed',
  'dead',
]);

export const IssueEinvoiceBodySchema = z.object({
  orderId: z.string().uuid(),
  /** When omitted, API uses EINVOICE_PROVIDER env (default stub). */
  provider: EinvoiceProviderSchema.optional(),
});

export type EinvoiceProviderCode = z.output<typeof EinvoiceProviderSchema>;
export type EinvoiceJobStatus = z.output<typeof EinvoiceJobStatusSchema>;
export type IssueEinvoiceBody = z.output<typeof IssueEinvoiceBodySchema>;
