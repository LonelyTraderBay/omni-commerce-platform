import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../../config/env";
import { EntitlementsService, type BillingStatus } from "./entitlements.service";
import { AI_TOKEN_USAGE_KIND } from "./ai-token-usage.service";

export const BILLING_SUPABASE = Symbol("BILLING_SUPABASE");

const ORGANIZATION_PLAN_SELECT =
  "id, plan, billing_customer_email, billing_status, plan_renews_at";
const CHANNEL_SELECT = "id";
const ORDER_SELECT = "id";
const INVOICE_SELECT =
  "id, org_id, period_start, period_end, amount_vnd, status, issued_at, note, created_at";

export type SupabaseLike = Pick<SupabaseClient, "from" | "rpc">;

type SupabaseError = {
  code?: string;
  message?: string;
};

type OrganizationPlanRow = {
  id: string;
  plan: string;
  billing_customer_email: string | null;
  billing_status: BillingStatus | null;
  plan_renews_at: string | null;
};

type InvoiceRow = {
  id: string;
  org_id: string;
  period_start: string;
  period_end: string;
  amount_vnd: number | string;
  status: "draft" | "issued" | "paid" | "void" | string;
  issued_at: string | null;
  note: string | null;
  created_at: string;
};

@Injectable()
export class BillingService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(BILLING_SUPABASE)
    supabase: SupabaseLike | undefined,
    private readonly entitlements: EntitlementsService,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async getPlan(orgId: string) {
    const organization = await this.getOrganizationPlan(orgId);
    const billingStatus = organization.billing_status ?? "active";
    const entitlements = await this.entitlements.getEntitlements(orgId);

    return {
      plan: organization.plan,
      billingStatus,
      billingCustomerEmail: organization.billing_customer_email,
      planRenewsAt: organization.plan_renews_at,
      entitlements,
      dunning: {
        autoConfirmBlocked:
          billingStatus === "past_due" || billingStatus === "suspended",
        reason:
          billingStatus === "active" ? null : `billing_${billingStatus}`,
      },
    };
  }

  async getUsage(orgId: string, at = new Date()) {
    const periodStart = startOfUtcMonthIso(at);
    const [pagesConnectedCount, aiTokensMonth, ordersCountMonth] =
      await Promise.all([
        this.countActivePages(orgId),
        this.sumAiTokens(orgId, periodStart),
        this.countOrders(orgId, periodStart),
      ]);

    return {
      periodStart,
      pagesConnectedCount,
      aiTokensMonth,
      ordersCountMonth,
    };
  }

  async listInvoices(orgId: string) {
    const { data, error } = await this.supabase
      .from("billing_invoices")
      .select(INVOICE_SELECT)
      .eq("org_id", orgId)
      .order("period_start", { ascending: false });

    if (error) {
      throwBillingError(error, "Could not list billing invoices");
    }

    return {
      invoices: ((data ?? []) as InvoiceRow[]).map(mapInvoice),
    };
  }

  private async getOrganizationPlan(orgId: string) {
    const { data, error } = await this.supabase
      .from("organizations")
      .select(ORGANIZATION_PLAN_SELECT)
      .eq("id", orgId)
      .maybeSingle();

    if (error) {
      throwBillingError(error, "Could not read billing plan");
    }
    if (!data) {
      throw new NotFoundException({
        code: "organization_not_found",
        message: "Organization was not found",
      });
    }

    return data as OrganizationPlanRow;
  }

  /**
   * These three meters used to fetch rows and count/sum them in Node with no
   * `.limit()` at all. PostgREST caps every response at `db-max-rows` (1000 by
   * default), so an org with 5,000 orders in a month was shown
   * `ordersCountMonth: 1000` — a wrong number presented as a fact, and the same
   * truncation under-summed AI token usage that quota enforcement reads.
   *
   * Counts now come from `count: "exact"` with `head: true`: Postgres does the
   * counting and no rows cross the wire. The token sum is a SQL aggregate
   * (`public.sum_usage_event_quantity`) for the same reason.
   */
  private async countActivePages(orgId: string) {
    const { count, error } = await this.supabase
      .from("channel_connections")
      .select(CHANNEL_SELECT, { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "active");

    if (error) {
      throwBillingError(error, "Could not count connected pages");
    }

    return count ?? 0;
  }

  private async countOrders(orgId: string, periodStart: string) {
    const { count, error } = await this.supabase
      .from("orders")
      .select(ORDER_SELECT, { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", periodStart);

    if (error) {
      throwBillingError(error, "Could not count monthly orders");
    }

    return count ?? 0;
  }

  private async sumAiTokens(orgId: string, periodStart: string) {
    const { data, error } = await this.supabase.rpc(
      "sum_usage_event_quantity",
      {
        p_org_id: orgId,
        p_kind: AI_TOKEN_USAGE_KIND,
        p_since: periodStart,
      },
    );

    if (error) {
      throwBillingError(error, "Could not sum monthly AI token usage");
    }

    // The function returns `text` so a bigint sum survives the JSON round-trip
    // intact; `toSafeNumber` is what rejects anything that is not a whole,
    // representable count.
    return toSafeNumber((data ?? "0") as number | string, "quantity");
  }
}

function mapInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    amountVnd: String(row.amount_vnd),
    status: row.status,
    issuedAt: row.issued_at,
    note: row.note,
    createdAt: row.created_at,
  };
}

function startOfUtcMonthIso(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

function toSafeNumber(value: number | string, fieldName: string) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throwInvalidQuantity(fieldName);
    }
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throwInvalidQuantity(fieldName);
}

function throwInvalidQuantity(fieldName: string): never {
  throw new InternalServerErrorException({
    code: "invalid_billing_quantity",
    message: `${fieldName} must be a non-negative safe integer`,
  });
}

function throwBillingError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "billing_failed",
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
