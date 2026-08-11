import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../../config/env";
import { PLAN_CATALOG, type PlanSlug } from "./plan-catalog";

export const ENTITLEMENTS_SUPABASE = Symbol("ENTITLEMENTS_SUPABASE");

const ENTITLEMENTS_SELECT =
  "org_id, max_pages, ai_monthly_token_limit, auto_confirm_allowed, updated_at";
const ORGANIZATION_BILLING_SELECT = "id, billing_status";

export type SupabaseLike = Pick<SupabaseClient, "from">;

type SupabaseError = {
  code?: string;
  message?: string;
};

type EntitlementsRow = {
  org_id: string;
  max_pages: number;
  ai_monthly_token_limit: number;
  auto_confirm_allowed: boolean;
  updated_at: string;
};

type OrganizationBillingRow = {
  id: string;
  billing_status: BillingStatus | null;
};

export type BillingStatus = "active" | "past_due" | "suspended";

@Injectable()
export class EntitlementsService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(ENTITLEMENTS_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async getEntitlements(orgId: string) {
    const { data, error } = await this.supabase
      .from("entitlements")
      .select(ENTITLEMENTS_SELECT)
      .eq("org_id", orgId)
      .maybeSingle();

    if (error) {
      throwEntitlementsError(error, "Could not read entitlements");
    }
    if (!data) {
      throw new NotFoundException({
        code: "entitlements_not_found",
        message: "Entitlements were not found",
      });
    }

    const billingStatus = await this.getBillingStatus(orgId);

    return mapEntitlements(data as EntitlementsRow, billingStatus);
  }

  async syncPlanEntitlements(orgId: string, plan: PlanSlug, updatedAt = new Date()) {
    const catalog = PLAN_CATALOG[plan];
    const timestamp = updatedAt.toISOString();
    const { data, error } = await this.supabase
      .from("entitlements")
      .upsert(
        {
          org_id: orgId,
          max_pages: catalog.maxPages,
          ai_monthly_token_limit: catalog.aiMonthlyTokenLimit,
          auto_confirm_allowed: catalog.autoConfirmAllowed,
          updated_at: timestamp,
        },
        { onConflict: "org_id" },
      )
      .select(ENTITLEMENTS_SELECT)
      .single();

    if (error) {
      throwEntitlementsError(error, "Could not sync plan entitlements");
    }

    const billingStatus = await this.getBillingStatus(orgId);

    return mapEntitlements(data as EntitlementsRow, billingStatus);
  }

  private async getBillingStatus(orgId: string) {
    const { data, error } = await this.supabase
      .from("organizations")
      .select(ORGANIZATION_BILLING_SELECT)
      .eq("id", orgId)
      .maybeSingle();

    if (error) {
      throwEntitlementsError(error, "Could not read billing status");
    }

    return ((data as OrganizationBillingRow | null)?.billing_status ??
      "active") as BillingStatus;
  }
}

function mapEntitlements(row: EntitlementsRow, billingStatus: BillingStatus = "active") {
  const autoConfirmBlockedReason =
    billingStatus === "past_due" || billingStatus === "suspended"
      ? `billing_${billingStatus}`
      : null;

  return {
    orgId: row.org_id,
    maxPages: row.max_pages,
    aiMonthlyTokenLimit: Number(row.ai_monthly_token_limit),
    autoConfirmAllowed:
      autoConfirmBlockedReason === null && row.auto_confirm_allowed,
    autoConfirmBlockedReason,
    updatedAt: row.updated_at,
  };
}

function throwEntitlementsError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "entitlements_read_failed",
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
