import { z } from "zod";

export const RoleSchema = z.enum(["owner", "cskh", "kho"]);

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  plan: z.string(),
  settingsJson: z.record(z.string(), z.unknown()).default({}),
  timezone: z.string().default("Asia/Ho_Chi_Minh"),
  locale: z.string().default("vi"),
  suspendedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export const MembershipSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  role: RoleSchema,
});
