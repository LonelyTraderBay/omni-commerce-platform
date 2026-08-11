import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

import { loadEnv } from "../../config/env";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import type { MembershipRole } from "../../common/guards/org.guard";
import { AuditService, type WriteAuditInput } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { isPlanSlug, type PlanSlug } from "../billing/plan-catalog";
import type {
  AcceptInviteBody,
  CreateInviteBody,
  CreateOrgBody,
  UpdateOrgSettingsBody,
} from "./dto";

export const IDENTITY_SERVICE_SUPABASE = Symbol("IDENTITY_SERVICE_SUPABASE");
export const IDENTITY_USER_SUPABASE_FACTORY = Symbol(
  "IDENTITY_USER_SUPABASE_FACTORY",
);

const ORGANIZATION_SELECT =
  "id, name, slug, plan, settings_json, timezone, locale, suspended_at, created_at, updated_at";
const MEMBERSHIP_SELECT = "id, org_id, user_id, role";
const MEMBERSHIP_EXPORT_SELECT =
  "id, org_id, user_id, role, created_at, updated_at";
const ENTITLEMENTS_SELECT =
  "org_id, max_pages, ai_monthly_token_limit, auto_confirm_allowed, updated_at";
const INVITE_SELECT = "id, org_id, email, role, expires_at, created_at, accepted_at";
const INVITE_ACCEPT_SELECT =
  "id, org_id, email, role, token_hash, expires_at, created_at, accepted_at";
const CONTACT_EXPORT_SELECT =
  "id, org_id, display_name, phone_e164, page_scoped_id, ig_scoped_id, tags_json, created_at, updated_at";
const CONVERSATION_SUMMARY_SELECT =
  "id, org_id, channel, channel_connection_id, contact_id, status, bot_paused, bot_epoch, assignee_user_id, last_message_at, created_at, updated_at";
const ORDER_ITEM_EXPORT_SELECT =
  "id, product_id, variant_id, title_snapshot, sku_snapshot, qty, unit_price_vnd, line_total_vnd";
const ORDER_EXPORT_SELECT = [
  "id, org_id, conversation_id, contact_id, status, payment_method, customer_name, phone_e164",
  "address_text, address_json, currency, subtotal_vnd, total_vnd, idempotency_key",
  "confirmed_at, shipped_at, cancelled_at, done_at, created_at, updated_at",
  `items:order_items(${ORDER_ITEM_EXPORT_SELECT})`,
].join(", ");
const EXPORT_LIMIT = 5_000;

export type SupabaseLike = Pick<SupabaseClient, "from" | "rpc">;
type UserSupabaseFactory = (accessToken: string) => SupabaseLike;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};
export type EntitlementsSyncer = Pick<
  EntitlementsService,
  "syncPlanEntitlements"
>;

type SupabaseError = {
  code?: string;
  message?: string;
};

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  settings_json: Record<string, unknown>;
  timezone: string;
  locale: string;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
};

type MembershipRow = {
  id: string;
  org_id: string;
  user_id: string;
  role: MembershipRole;
};

type MembershipExportRow = MembershipRow & {
  created_at: string;
  updated_at: string;
};

type EntitlementsRow = {
  org_id: string;
  max_pages: number;
  ai_monthly_token_limit: number;
  auto_confirm_allowed: boolean;
  updated_at: string;
};

type InviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: MembershipRole;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
};

type InviteAcceptRow = InviteRow & {
  token_hash: string;
};

type MembershipWithOrganizationRow = MembershipRow & {
  organizations: OrganizationRow | OrganizationRow[] | null;
};

type CreateOrganizationWithOwnerRow = {
  organization: OrganizationRow;
  membership: MembershipRow;
  entitlements: EntitlementsRow;
};

type ContactExportRow = {
  id: string;
  org_id: string;
  display_name: string | null;
  phone_e164: string | null;
  page_scoped_id: string | null;
  ig_scoped_id: string | null;
  tags_json: Record<string, unknown> | unknown[];
  created_at: string;
  updated_at: string;
};

type ConversationSummaryRow = {
  id: string;
  org_id: string;
  channel: "messenger" | "instagram";
  channel_connection_id: string;
  contact_id: string;
  status: string;
  bot_paused: boolean;
  bot_epoch: number;
  assignee_user_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

type OrderExportRow = {
  id: string;
  org_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  status: string;
  payment_method: string;
  customer_name: string | null;
  phone_e164: string | null;
  address_text: string | null;
  address_json: Record<string, unknown>;
  currency: "VND";
  subtotal_vnd: number | string;
  total_vnd: number | string;
  idempotency_key: string | null;
  confirmed_at: string | null;
  shipped_at: string | null;
  cancelled_at: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  items?: OrderItemExportRow[] | null;
};

type OrderItemExportRow = {
  id: string;
  product_id: string;
  variant_id: string;
  title_snapshot: string;
  sku_snapshot: string;
  qty: number;
  unit_price_vnd: number | string;
  line_total_vnd: number | string;
};

@Injectable()
export class IdentityService {
  private readonly serviceSupabase: SupabaseLike;
  private readonly userSupabaseFactory: UserSupabaseFactory;
  private readonly audit: AuditWriter;
  private readonly entitlements: EntitlementsSyncer;

  constructor(
    @Optional()
    @Inject(IDENTITY_SERVICE_SUPABASE)
    serviceSupabase?: SupabaseLike,
    @Optional()
    @Inject(IDENTITY_USER_SUPABASE_FACTORY)
    userSupabaseFactory?: UserSupabaseFactory,
    @Optional()
    @Inject(AuditService)
    audit?: AuditWriter,
    @Optional()
    @Inject(EntitlementsService)
    entitlements?: EntitlementsSyncer,
  ) {
    this.serviceSupabase = serviceSupabase ?? createSupabaseServiceClient();
    this.userSupabaseFactory =
      userSupabaseFactory ?? createSupabaseUserClient;
    this.audit = audit ?? new AuditService(this.serviceSupabase);
    this.entitlements =
      entitlements ?? new EntitlementsService(this.serviceSupabase);
  }

  async createOrganization(user: AuthenticatedUser, body: CreateOrgBody) {
    // RLS cannot authorize the very first organization insert because the owner
    // membership does not exist yet. Keep service-role writes scoped to this
    // atomic bootstrap RPC after JwtAuthGuard has resolved the user.
    const { data, error } = await this.serviceSupabase
      .rpc("create_organization_with_owner", {
        p_name: body.name,
        p_owner_user_id: user.id,
        p_slug: body.slug,
      })
      .single();

    if (error) {
      throwIdentityError(error, "Could not create organization");
    }

    const row = data as CreateOrganizationWithOwnerRow;
    const organization = mapOrganization(row.organization);

    // create_organization_with_owner() inserts the entitlements row scoped
    // only by org_id, so it falls back to the `entitlements` table's raw
    // column defaults (0 pages, 0 AI tokens, no auto-confirm) rather than the
    // limits the organization's plan actually grants per PLAN_CATALOG. Sync
    // entitlements to the plan right away so a brand-new org is never
    // provisioned with less than its own plan promises.
    const plan: PlanSlug = isPlanSlug(organization.plan)
      ? organization.plan
      : "free";
    const entitlements = await this.entitlements.syncPlanEntitlements(
      organization.id,
      plan,
    );

    return {
      organization,
      membership: mapMembership(row.membership),
      entitlements,
    };
  }

  async listOrganizations(user: AuthenticatedUser, accessToken: string) {
    const supabase = this.userSupabaseFactory(accessToken);
    const { data, error } = await supabase
      .from("memberships")
      .select(`${MEMBERSHIP_SELECT}, organizations (${ORGANIZATION_SELECT})`)
      .eq("user_id", user.id);

    if (error) {
      throwIdentityError(error, "Could not list organizations");
    }

    return ((data ?? []) as MembershipWithOrganizationRow[])
      .map((row) => {
        const organization = Array.isArray(row.organizations)
          ? row.organizations[0]
          : row.organizations;

        if (!organization) {
          return null;
        }

        return {
          organization: mapOrganization(organization),
          membership: mapMembership(row),
        };
      })
      .filter(
        (
          row,
        ): row is {
          organization: ReturnType<typeof mapOrganization>;
          membership: ReturnType<typeof mapMembership>;
        } => row !== null,
      );
  }

  async updateOrgSettings(orgId: string, body: UpdateOrgSettingsBody) {
    const current = await this.fetchOrganization(orgId);
    // Always merge onto the existing settings_json (spread first) so keys
    // this endpoint doesn't know about (e.g. aiDraftMaxAmountVnd,
    // allowCskhApprove — see the migration's column comment) survive a
    // partial toggle update instead of being wiped by it. Written keys are
    // always snake_case to match every other column in this schema;
    // orders.service.ts's autoConfirmEnabled() and the frontend's
    // normalizeSettings() both already tolerate either case defensively, so
    // this does not break anything still reading the old camelCase shape.
    const nextSettings: Record<string, unknown> = {
      ...current.settings_json,
      ...(body.autoConfirm !== undefined
        ? { auto_confirm: body.autoConfirm }
        : {}),
      ...(body.aiReplies !== undefined
        ? { ai_replies: body.aiReplies }
        : {}),
      ...(body.aiDraftOrders !== undefined
        ? { ai_draft_orders: body.aiDraftOrders }
        : {}),
      ...(body.aiProductSuggestions !== undefined
        ? { ai_product_suggestions: body.aiProductSuggestions }
        : {}),
    };

    const { data, error } = await this.serviceSupabase
      .from("organizations")
      .update({
        settings_json: nextSettings,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORGANIZATION_SELECT)
      .maybeSingle();

    if (error) {
      throwIdentityError(error, "Could not update organization settings");
    }
    if (!data) {
      throw new NotFoundException({
        code: "organization_not_found",
        message: "Organization was not found",
      });
    }

    return { organization: mapOrganization(data as OrganizationRow) };
  }

  async createInvite(orgId: string, body: CreateInviteBody) {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    // Membership invite inserts are not granted to authenticated clients yet.
    // OrgGuard and the controller's owner-role check run first; service role is
    // used only to persist the stub invite row.
    const { data, error } = await this.serviceSupabase
      .from("membership_invites")
      .insert({
        org_id: orgId,
        email: body.email,
        role: body.role,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
      })
      .select(INVITE_SELECT)
      .single();

    if (error) {
      throwIdentityError(error, "Could not create membership invite");
    }

    // Raw token returned once for local/Mailpit copy; only the hash is stored.
    return { invite: mapInvite(data as InviteRow), token };
  }

  async listInvites(orgId: string, now = new Date()) {
    const { data, error } = await this.serviceSupabase
      .from("membership_invites")
      .select(INVITE_SELECT)
      .eq("org_id", orgId)
      .is("accepted_at", null)
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false });

    if (error) {
      throwIdentityDataError(error, "Could not list membership invites");
    }

    return {
      invites: ((data ?? []) as InviteRow[]).map(mapInvite),
    };
  }

  async acceptInvite(user: AuthenticatedUser, body: AcceptInviteBody) {
    const email = user.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException({
        code: "invite_email_required",
        message: "Authenticated user email is required to accept an invite",
      });
    }

    const tokenHash = createHash("sha256").update(body.token).digest("hex");
    const { data, error } = await this.serviceSupabase
      .from("membership_invites")
      .select(INVITE_ACCEPT_SELECT)
      .eq("token_hash", tokenHash)
      .is("accepted_at", null)
      .maybeSingle();

    if (error) {
      throwIdentityDataError(error, "Could not read membership invite");
    }

    const invite = data as InviteAcceptRow | null;
    if (!invite) {
      throw new NotFoundException({
        code: "invite_not_found",
        message: "Invite was not found or already accepted",
      });
    }

    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      throw new BadRequestException({
        code: "invite_expired",
        message: "Invite has expired",
      });
    }

    if (invite.email.trim().toLowerCase() !== email) {
      throw new ForbiddenException({
        code: "invite_email_mismatch",
        message: "Signed-in email does not match the invite",
      });
    }

    const acceptedAt = new Date().toISOString();
    const { data: membershipData, error: membershipError } =
      await this.serviceSupabase
        .from("memberships")
        .insert({
          org_id: invite.org_id,
          user_id: user.id,
          role: invite.role,
        })
        .select(MEMBERSHIP_SELECT)
        .single();

    if (membershipError) {
      throwIdentityError(membershipError, "Could not create membership");
    }

    const { error: acceptError } = await this.serviceSupabase
      .from("membership_invites")
      .update({ accepted_at: acceptedAt })
      .eq("id", invite.id)
      .is("accepted_at", null);

    if (acceptError) {
      throwIdentityError(acceptError, "Could not invalidate membership invite");
    }

    return {
      membership: mapMembership(membershipData as MembershipRow),
      invite: mapInvite({ ...invite, accepted_at: acceptedAt }),
    };
  }

  async exportOrganizationData(input: {
    orgId: string;
    actorUserId: string;
    now?: Date;
  }) {
    const exportedAt = (input.now ?? new Date()).toISOString();
    const [organization, memberships, contacts, conversations, orders] =
      await Promise.all([
        this.fetchOrganization(input.orgId),
        this.fetchMemberships(input.orgId),
        this.fetchContacts(input.orgId),
        this.fetchConversationSummaries(input.orgId),
        this.fetchOrders(input.orgId),
      ]);

    const bundle = {
      exportedAt,
      orgId: input.orgId,
      generatedByUserId: input.actorUserId,
      organization: mapOrganization(organization),
      memberships: memberships.map(mapMembershipExport),
      contacts: contacts.map(mapContactExport),
      conversations: conversations.map(mapConversationSummary),
      orders: orders.map(mapOrderExport),
    };

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: "user",
      action: "organization.pdpa_exported",
      entityType: "organization",
      entityId: input.orgId,
      meta: {
        exportedAt,
        counts: {
          memberships: bundle.memberships.length,
          contacts: bundle.contacts.length,
          conversations: bundle.conversations.length,
          orders: bundle.orders.length,
        },
      },
    });

    return bundle;
  }

  async requestOrganizationDelete(input: {
    orgId: string;
    actorUserId: string;
    now?: Date;
  }) {
    const requestedAt = (input.now ?? new Date()).toISOString();
    const request = {
      orgId: input.orgId,
      status: "pending" as const,
      requestedByUserId: input.actorUserId,
      requestedAt,
    };

    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: "user",
      action: "organization.delete_requested",
      entityType: "organization",
      entityId: input.orgId,
      meta: request,
    });

    return { deleteRequest: request };
  }

  private async fetchOrganization(orgId: string) {
    const { data, error } = await this.serviceSupabase
      .from("organizations")
      .select(ORGANIZATION_SELECT)
      .eq("id", orgId)
      .maybeSingle();

    if (error) {
      throwIdentityDataError(error, "Could not read organization");
    }
    if (!data) {
      throw new NotFoundException({
        code: "organization_not_found",
        message: "Organization was not found",
      });
    }

    return data as OrganizationRow;
  }

  private async fetchMemberships(orgId: string) {
    const { data, error } = await this.serviceSupabase
      .from("memberships")
      .select(MEMBERSHIP_EXPORT_SELECT)
      .eq("org_id", orgId)
      .order("created_at", { ascending: true })
      .limit(EXPORT_LIMIT);

    if (error) {
      throwIdentityDataError(error, "Could not read memberships");
    }

    return (data ?? []) as MembershipExportRow[];
  }

  private async fetchContacts(orgId: string) {
    const { data, error } = await this.serviceSupabase
      .from("contacts")
      .select(CONTACT_EXPORT_SELECT)
      .eq("org_id", orgId)
      .order("created_at", { ascending: true })
      .limit(EXPORT_LIMIT);

    if (error) {
      throwIdentityDataError(error, "Could not read contacts");
    }

    return (data ?? []) as ContactExportRow[];
  }

  private async fetchConversationSummaries(orgId: string) {
    const { data, error } = await this.serviceSupabase
      .from("conversations")
      .select(CONVERSATION_SUMMARY_SELECT)
      .eq("org_id", orgId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(EXPORT_LIMIT);

    if (error) {
      throwIdentityDataError(error, "Could not read conversations");
    }

    return (data ?? []) as ConversationSummaryRow[];
  }

  private async fetchOrders(orgId: string) {
    const { data, error } = await this.serviceSupabase
      .from("orders")
      .select(ORDER_EXPORT_SELECT)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(EXPORT_LIMIT);

    if (error) {
      throwIdentityDataError(error, "Could not read orders");
    }

    return (data ?? []) as unknown as OrderExportRow[];
  }
}

function mapOrganization(row: OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    settingsJson: row.settings_json,
    timezone: row.timezone,
    locale: row.locale,
    suspendedAt: row.suspended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembership(row: MembershipRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role,
  };
}

function mapMembershipExport(row: MembershipExportRow) {
  return {
    ...mapMembership(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


function mapInvite(row: InviteRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
  };
}

function mapContactExport(row: ContactExportRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    phoneE164: row.phone_e164,
    pageScopedId: row.page_scoped_id,
    igScopedId: row.ig_scoped_id,
    tagsJson: row.tags_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationSummary(row: ConversationSummaryRow) {
  return {
    id: row.id,
    channel: row.channel,
    channelConnectionId: row.channel_connection_id,
    contactId: row.contact_id,
    status: row.status,
    botPaused: row.bot_paused,
    botEpoch: row.bot_epoch,
    assigneeUserId: row.assignee_user_id,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrderExport(row: OrderExportRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    status: row.status,
    paymentMethod: row.payment_method,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    addressText: row.address_text,
    addressJson: row.address_json,
    currency: row.currency,
    subtotalVnd: row.subtotal_vnd.toString(),
    totalVnd: row.total_vnd.toString(),
    idempotencyKey: row.idempotency_key,
    confirmedAt: row.confirmed_at,
    shippedAt: row.shipped_at,
    cancelledAt: row.cancelled_at,
    doneAt: row.done_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: (row.items ?? []).map(mapOrderItemExport),
  };
}

function mapOrderItemExport(row: OrderItemExportRow) {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    titleSnapshot: row.title_snapshot,
    skuSnapshot: row.sku_snapshot,
    qty: row.qty,
    unitPriceVnd: row.unit_price_vnd.toString(),
    lineTotalVnd: row.line_total_vnd.toString(),
  };
}

function throwIdentityError(error: SupabaseError, message: string): never {
  if (error.code === "23505") {
    throw new ConflictException({
      code: "identity_conflict",
      message,
    });
  }

  throw new InternalServerErrorException({
    code: "identity_write_failed",
    message,
  });
}

function throwIdentityDataError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "identity_read_failed",
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

function createSupabaseUserClient(accessToken: string) {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
