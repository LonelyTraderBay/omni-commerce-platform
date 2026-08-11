import { z } from 'zod';

export const SendInboxMessageBodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export type SendInboxMessageBody = z.infer<typeof SendInboxMessageBodySchema>;
