import { z } from "zod";

export const RoleSchema = z.enum(["owner", "cskh", "kho"]);

export const CreateOrgBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();

export const CreateInviteBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: RoleSchema.default("cskh"),
  })
  .strict();

export const AcceptInviteBodySchema = z
  .object({
    token: z.string().trim().min(32).max(128),
  })
  .strict();

export const UpdateOrgSettingsBodySchema = z
  .object({
    autoConfirm: z.boolean().optional(),
    aiReplies: z.boolean().optional(),
    aiDraftOrders: z.boolean().optional(),
    aiProductSuggestions: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required",
  });

export type CreateOrgBody = z.infer<typeof CreateOrgBodySchema>;
export type CreateInviteBody = z.infer<typeof CreateInviteBodySchema>;
export type AcceptInviteBody = z.infer<typeof AcceptInviteBodySchema>;
export type UpdateOrgSettingsBody = z.infer<typeof UpdateOrgSettingsBodySchema>;
