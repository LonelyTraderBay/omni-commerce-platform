import { z } from "zod";

export const CompleteMetaOAuthBodySchema = z
  .object({
    code: z.string().trim().min(1),
    state: z.string().trim().min(1),
  })
  .strict();

export type CompleteMetaOAuthBody = z.infer<
  typeof CompleteMetaOAuthBodySchema
>;

export const ConnectZaloBodySchema = z
  .object({
    oaId: z.string().trim().min(1),
    accessToken: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
  })
  .strict();

export type ConnectZaloBody = z.infer<typeof ConnectZaloBodySchema>;
