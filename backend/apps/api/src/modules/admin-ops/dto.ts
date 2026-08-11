import { z } from "zod";

import { PLAN_CATALOG } from "../billing/plan-catalog";

export const SetGlobalFlagBodySchema = z
  .object({
    enabled: z.boolean(),
    payloadJson: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type SetGlobalFlagBody = z.infer<typeof SetGlobalFlagBodySchema>;

export const IssueInvoiceBodySchema = z
  .object({
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    amountVnd: z.union([
      z.string().regex(/^\d+$/),
      z.number().int().min(0),
    ]),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict()
  .refine(
    (body) => new Date(body.periodEnd).getTime() > new Date(body.periodStart).getTime(),
    {
      message: "periodEnd must be after periodStart",
      path: ["periodEnd"],
    },
  );

export type IssueInvoiceBody = z.infer<typeof IssueInvoiceBodySchema>;

export const UpdateOrgPlanBodySchema = z
  .object({
    plan: z.enum(Object.keys(PLAN_CATALOG) as [string, ...string[]]),
  })
  .strict();

export type UpdateOrgPlanBody = z.infer<typeof UpdateOrgPlanBodySchema>;
