import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { loadEnv } from '../../config/env';

export const AI_RUNS_SUPABASE = Symbol('AI_RUNS_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

const DEFAULT_MODEL_ALLOWLIST = 'gemini-2.0-flash,advisor-stub,gpt-4o-mini';
const AI_RUN_SELECT =
  'id, org_id, conversation_id, message_id, prompt_version, model, input_tokens, output_tokens, tools_json, citations_json, status, created_at';

const TokenCountSchema = z.number().int().min(0).safe();
const JsonRecordArraySchema = z.array(z.record(z.string(), z.unknown()));

export const WriteAiRunSchema = z.object({
  orgId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  messageId: z.string().uuid().nullable().optional(),
  promptVersion: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  tokens: z
    .object({
      prompt: TokenCountSchema.optional(),
      completion: TokenCountSchema.optional(),
      input: TokenCountSchema.optional(),
      output: TokenCountSchema.optional(),
      total: TokenCountSchema.optional(),
    })
    .optional(),
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  tools: JsonRecordArraySchema.default([]),
  citations: JsonRecordArraySchema.default([]),
  status: z.string().trim().min(1).max(64),
});

export type WriteAiRunInput = z.output<typeof WriteAiRunSchema>;

type SupabaseError = {
  code?: string;
  message?: string;
};

type AiRunRow = {
  id: string;
  org_id: string;
  conversation_id: string | null;
  message_id: string | null;
  prompt_version: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  tools_json: Record<string, unknown>[];
  citations_json: Record<string, unknown>[];
  status: string | null;
  created_at: string;
};

@Injectable()
export class AiRunsService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(AI_RUNS_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async writeRun(input: WriteAiRunInput) {
    assertModelAllowed(input.model);

    const { data, error } = await this.supabase
      .from('ai_runs')
      .insert({
        org_id: input.orgId,
        conversation_id: input.conversationId ?? null,
        message_id: input.messageId ?? null,
        prompt_version: input.promptVersion,
        model: input.model,
        input_tokens:
          input.inputTokens ??
          input.tokens?.input ??
          input.tokens?.prompt ??
          null,
        output_tokens:
          input.outputTokens ??
          input.tokens?.output ??
          input.tokens?.completion ??
          null,
        tools_json: input.tools,
        citations_json: input.citations,
        status: input.status,
      })
      .select(AI_RUN_SELECT)
      .single();

    if (error) {
      throwAiRunError(error, 'Could not write AI run');
    }

    return { aiRun: mapAiRun(data as AiRunRow) };
  }
}

export function parseWriteAiRunBody(body: unknown) {
  const parsed = WriteAiRunSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      message: 'Request body is invalid',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function assertModelAllowed(model: string) {
  const allowlist = (process.env.AI_MODEL_ALLOWLIST ?? DEFAULT_MODEL_ALLOWLIST)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!allowlist.includes(model)) {
    throw new BadRequestException({
      code: 'ai_model_not_allowed',
      message: 'AI model is not in AI_MODEL_ALLOWLIST',
    });
  }
}

function mapAiRun(row: AiRunRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    promptVersion: row.prompt_version,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    tools: row.tools_json,
    citations: row.citations_json,
    status: row.status,
    createdAt: row.created_at,
  };
}

function throwAiRunError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: 'ai_run_write_failed',
    message,
  });
}

function createSupabaseServiceClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
