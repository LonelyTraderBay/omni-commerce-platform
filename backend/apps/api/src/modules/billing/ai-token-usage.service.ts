import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { loadEnv } from "../../config/env";

export const AI_TOKEN_USAGE_SUPABASE = Symbol("AI_TOKEN_USAGE_SUPABASE");

export type SupabaseLike = Pick<SupabaseClient, "from" | "rpc">;

export const AI_TOKEN_USAGE_KIND = "ai_tokens";

const ENTITLEMENTS_SELECT = "org_id, ai_monthly_token_limit";

export const RecordAiTokenUsageSchema = z.object({
  orgId: z.string().uuid(),
  quantity: z.number().int().min(1),
  refType: z.string().trim().min(1).max(64).nullable().optional(),
  refId: z.string().uuid().nullable().optional(),
});

export type RecordAiTokenUsageInput = z.output<typeof RecordAiTokenUsageSchema>;

export type AiTokenQuotaStatus = {
  allowed: boolean;
  exceeded: boolean;
  used: number;
  limit: number;
  periodStart: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type EntitlementsRow = {
  org_id: string;
  ai_monthly_token_limit: number | string;
};

@Injectable()
export class AiTokenUsageService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(AI_TOKEN_USAGE_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async getQuotaStatus(orgId: string): Promise<AiTokenQuotaStatus> {
    const limit = await this.loadMonthlyLimit(orgId);
    const used = await this.loadMonthlyUsage(orgId);
    const periodStart = startOfUtcMonthIso(new Date());

    if (limit <= 0n) {
      return {
        allowed: false,
        exceeded: true,
        used: toSafeNumber(used),
        limit: toSafeNumber(limit),
        periodStart,
      };
    }

    const exceeded = used >= limit;
    return {
      allowed: !exceeded,
      exceeded,
      used: toSafeNumber(used),
      limit: toSafeNumber(limit),
      periodStart,
    };
  }

  async recordUsage(input: RecordAiTokenUsageInput) {
    const { error } = await this.supabase.from("usage_events").insert({
      org_id: input.orgId,
      kind: AI_TOKEN_USAGE_KIND,
      quantity: input.quantity,
      ref_type: input.refType ?? null,
      ref_id: input.refId ?? null,
    });

    if (error) {
      throwUsageError(error, "Could not record AI token usage");
    }
  }

  private async loadMonthlyLimit(orgId: string) {
    const { data, error } = await this.supabase
      .from("entitlements")
      .select(ENTITLEMENTS_SELECT)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwUsageError(error, "Could not read entitlements");
    }
    if (!data) {
      throw new NotFoundException({
        code: "entitlements_not_found",
        message: "Entitlements were not found",
      });
    }

    return toBigIntQuantity(
      (data as EntitlementsRow).ai_monthly_token_limit,
      "ai_monthly_token_limit",
    );
  }

  /**
   * Monthly AI token consumption, aggregated in SQL.
   *
   * This is the number the quota gate compares against the entitlement limit.
   * It used to fetch `usage_events` rows and sum them in Node with no `.limit()`,
   * which PostgREST silently truncates at `db-max-rows` (1000 by default) — so
   * the busiest orgs, the only ones that can actually exceed a token limit, were
   * exactly the ones whose usage was under-counted and whose limit therefore
   * never engaged.
   */
  private async loadMonthlyUsage(orgId: string) {
    const periodStart = startOfUtcMonthIso(new Date());
    const { data, error } = await this.supabase.rpc(
      "sum_usage_event_quantity",
      {
        p_org_id: orgId,
        p_kind: AI_TOKEN_USAGE_KIND,
        p_since: periodStart,
      },
    );

    if (error) {
      throwUsageError(error, "Could not read AI token usage");
    }

    return toBigIntQuantity((data ?? "0") as number | string, "quantity");
  }
}

export function parseRecordAiTokenUsageBody(body: unknown) {
  const parsed = RecordAiTokenUsageSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: "invalid_request",
      message: "Request body is invalid",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function startOfUtcMonthIso(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

function toBigIntQuantity(value: number | string, fieldName: string) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throwInvalidQuantity(fieldName);
    }
    return BigInt(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }

  throwInvalidQuantity(fieldName);
}

function toSafeNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InternalServerErrorException({
      code: "token_quota_overflow",
      message: "Token quota value exceeds JavaScript safe integer range",
    });
  }

  return Number(value);
}

function throwInvalidQuantity(fieldName: string): never {
  throw new InternalServerErrorException({
    code: "invalid_token_quantity",
    message: `${fieldName} must be a non-negative integer`,
  });
}

function throwUsageError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "ai_token_usage_failed",
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
