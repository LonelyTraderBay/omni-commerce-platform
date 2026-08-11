import { z } from 'zod';

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const AdvisorSuggestBodySchema = z
  .object({
    goal: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .default({});

export const AdvisorAiResponseSchema = z.object({
  suggestionsText: z.string().trim().min(1),
  disclaimer: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  tokens: z
    .object({
      input: z.number().int().min(0).optional(),
      output: z.number().int().min(0).optional(),
      total: z.number().int().min(0).optional(),
    })
    .optional(),
  toolsUsed: z.array(JsonRecordSchema).default([]),
  citations: z.array(JsonRecordSchema).default([]),
});

export type AdvisorSuggestBody = z.output<typeof AdvisorSuggestBodySchema>;
export type AdvisorAiResponse = z.output<typeof AdvisorAiResponseSchema>;
