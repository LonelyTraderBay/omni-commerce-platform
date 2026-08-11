import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

import { encryptToken } from "../../common/crypto/token-crypto";
import { loadEnv, type Env } from "../../config/env";
import {
  createGraphClientFromEnv,
  type GraphClient,
  type MetaDebugTokenResponse,
  type MetaManagedPage,
} from "../../integrations/meta/graph.client";
import { AuditService, type WriteAuditInput } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";

export const CHANNELS_SUPABASE = Symbol("CHANNELS_SUPABASE");
export const CHANNELS_GRAPH = Symbol("CHANNELS_GRAPH");
export const CHANNELS_ENV = Symbol("CHANNELS_ENV");

const CHANNEL_SELECT =
  "id, org_id, provider, external_page_id, external_ig_id, status, created_at";
const META_OAUTH_BASE_URL = "https://www.facebook.com";
const META_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Phase 1 scopes. Revisit when Meta App Review requirements change.
const META_OAUTH_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_messages",
  "pages_read_engagement",
] as const;

export type SupabaseLike = Pick<SupabaseClient, "from">;
export type GraphLike = Pick<
  GraphClient,
  | "exchangeCodeForToken"
  | "debugToken"
  | "getManagedPages"
  | "getPageAccessToken"
>;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};
export type EntitlementsReader = Pick<EntitlementsService, "getEntitlements">;
export type ChannelsEnv = Pick<
  Env,
  | "META_APP_ID"
  | "META_APP_SECRET"
  | "META_REDIRECT_URI"
  | "META_GRAPH_VERSION"
  | "SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "TOKEN_ENCRYPTION_KEY"
> &
  Partial<Pick<Env, "META_INTEGRATION_MODE">>;

type CompleteOAuthInput = {
  code: string;
  orgId: string;
  state: string;
  userId: string;
};

type ConnectZaloInput = {
  accessToken: string;
  displayName?: string;
  oaId: string;
  orgId: string;
  userId: string;
};

type ChannelProvider = "meta_page" | "meta_ig" | "zalo_oa";
type ChannelStatus = "active" | "needs_reauth" | "revoked";

type ChannelConnectionRow = {
  id: string;
  org_id: string;
  provider: ChannelProvider;
  external_page_id: string;
  external_ig_id: string | null;
  status: ChannelStatus;
  created_at: string;
};

type ChannelConnectionUpsert = {
  org_id: string;
  provider: ChannelProvider;
  external_page_id: string;
  external_ig_id: string | null;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  status: "active";
  metadata_json: Record<string, unknown>;
  updated_at: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

@Injectable()
export class ChannelsService {
  private readonly supabase: SupabaseLike;
  private readonly graph: GraphLike;
  private readonly audit?: AuditWriter;
  private readonly env: ChannelsEnv;
  private readonly entitlements?: EntitlementsReader;

  constructor(
    @Optional()
    @Inject(CHANNELS_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(CHANNELS_GRAPH)
    graph?: GraphLike,
    @Optional()
    @Inject(AuditService)
    audit?: AuditWriter,
    @Optional()
    @Inject(CHANNELS_ENV)
    env?: ChannelsEnv,
    @Optional()
    @Inject(EntitlementsService)
    entitlements?: EntitlementsReader,
  ) {
    this.env = env ?? loadEnv();
    this.supabase = supabase ?? createSupabaseServiceClient(this.env);
    this.graph = graph ?? createGraphClientFromEnv();
    this.audit = audit;
    this.entitlements = entitlements;
  }

  async getMetaOAuthUrl(input: { orgId: string; userId: string }) {
    const state = await this.createOAuthState(input);
    if (this.env.META_INTEGRATION_MODE === "stub") {
      const localUrl = new URL(this.env.META_REDIRECT_URI);
      localUrl.searchParams.set("code", "local-meta-code");
      localUrl.searchParams.set("state", state);
      return { url: localUrl.toString() };
    }

    const url = new URL(
      `${META_OAUTH_BASE_URL}/${this.env.META_GRAPH_VERSION}/dialog/oauth`,
    );
    url.searchParams.set("client_id", this.env.META_APP_ID);
    url.searchParams.set("redirect_uri", this.env.META_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", META_OAUTH_SCOPES.join(","));
    url.searchParams.set("state", state);

    return { url: url.toString() };
  }

  async completeOAuth(input: CompleteOAuthInput) {
    await this.consumeOAuthState(input);
    const now = new Date().toISOString();
    const { userToken, tokenExpiresAt, debug } =
      await this.exchangeAndValidateUserToken(input.code);
    const pages = await this.getManagedPages(userToken);

    if (pages.length === 0) {
      throw new BadRequestException({
        code: "meta_no_managed_pages",
        message: "Meta account does not manage any pages",
      });
    }

    const rows: ChannelConnectionUpsert[] = [];
    for (const page of pages) {
      rows.push(
        ...(await this.buildConnectionRows({
          page,
          userToken,
          orgId: input.orgId,
          userId: input.userId,
          tokenExpiresAt,
          debug,
          now,
        })),
      );
    }
    await this.ensureWithinMaxPages(input.orgId, rows);

    const { data, error } = await this.supabase
      .from("channel_connections")
      .upsert(rows, { onConflict: "org_id,provider,external_page_id" })
      .select(CHANNEL_SELECT);

    if (error) {
      throwChannelsError(error, "Could not connect Meta channels");
    }

    const connections = (data ?? []) as ChannelConnectionRow[];
    await Promise.all(
      connections.map((connection) =>
        this.audit?.writeAudit({
          orgId: connection.org_id,
          actorUserId: input.userId,
          actorType: "user",
          action: "channel.connected",
          entityType: "channel_connection",
          entityId: connection.id,
          meta: {
            provider: connection.provider,
            externalPageId: connection.external_page_id,
            externalIgId: connection.external_ig_id,
          },
        }),
      ),
    );

    return { connections: connections.map(mapConnection) };
  }

  private async createOAuthState(input: { orgId: string; userId: string }) {
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + META_OAUTH_STATE_TTL_MS).toISOString();
    const { error } = await this.supabase.from("oauth_states").insert({
      org_id: input.orgId,
      user_id: input.userId,
      state,
      expires_at: expiresAt,
    });

    if (error) {
      throwChannelsError(error, "Could not start Meta OAuth");
    }

    return state;
  }

  private async consumeOAuthState(input: CompleteOAuthInput) {
    const state = input.state.trim();
    if (!state) {
      throwInvalidOAuthState();
    }

    const { data, error } = await this.supabase
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .eq("org_id", input.orgId)
      .eq("user_id", input.userId)
      .gt("expires_at", new Date().toISOString())
      .select("state")
      .maybeSingle();

    if (error) {
      throwChannelsError(error, "Could not validate Meta OAuth state");
    }
    if (!data) {
      throwInvalidOAuthState();
    }
  }

  async listConnections(orgId: string) {
    const { data, error } = await this.supabase
      .from("channel_connections")
      .select(CHANNEL_SELECT)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });

    if (error) {
      throwChannelsError(error, "Could not list channel connections");
    }

    return ((data ?? []) as ChannelConnectionRow[]).map(mapConnection);
  }

  async connectZalo(input: ConnectZaloInput) {
    const now = new Date().toISOString();
    const row: ChannelConnectionUpsert = {
      org_id: input.orgId,
      provider: "zalo_oa",
      external_page_id: input.oaId,
      external_ig_id: null,
      access_token_enc: encryptToken(
        input.accessToken,
        this.env.TOKEN_ENCRYPTION_KEY,
      ),
      refresh_token_enc: null,
      token_expires_at: null,
      status: "active",
      metadata_json: {
        channel: "zalo",
        connectedByUserId: input.userId,
        displayName: input.displayName ?? null,
      },
      updated_at: now,
    };

    await this.ensureWithinMaxPages(input.orgId, [row]);

    const { data, error } = await this.supabase
      .from("channel_connections")
      .upsert([row], { onConflict: "org_id,provider,external_page_id" })
      .select(CHANNEL_SELECT);

    if (error) {
      throwChannelsError(error, "Could not connect Zalo OA channel");
    }

    const connection = ((data ?? []) as ChannelConnectionRow[])[0];
    if (!connection) {
      throwChannelsError(
        { message: "Zalo OA upsert returned no connection" },
        "Could not connect Zalo OA channel",
      );
    }

    await this.audit?.writeAudit({
      orgId: connection.org_id,
      actorUserId: input.userId,
      actorType: "user",
      action: "channel.connected",
      entityType: "channel_connection",
      entityId: connection.id,
      meta: {
        provider: connection.provider,
        externalPageId: connection.external_page_id,
        externalIgId: connection.external_ig_id,
      },
    });

    return { connection: mapConnection(connection) };
  }

  async revokeConnection(
    orgId: string,
    connectionId: string,
    revokedAt = new Date(),
  ) {
    const { data, error } = await this.supabase
      .from("channel_connections")
      .update({
        status: "revoked",
        updated_at: revokedAt.toISOString(),
      })
      .eq("id", connectionId)
      .eq("org_id", orgId)
      .select(CHANNEL_SELECT)
      .maybeSingle();

    if (error) {
      throwChannelsError(error, "Could not revoke channel connection");
    }
    if (!data) {
      throw new NotFoundException({
        code: "channel_connection_not_found",
        message: "Channel connection was not found",
      });
    }

    return { connection: mapConnection(data as ChannelConnectionRow) };
  }

  private async exchangeAndValidateUserToken(code: string) {
    try {
      const token = await this.graph.exchangeCodeForToken(code);
      const debug = await this.graph.debugToken(token.access_token);
      if (!debug.data.is_valid) {
        throw new BadRequestException({
          code: "meta_token_invalid",
          message: "Meta OAuth token is invalid",
        });
      }
      if (debug.data.app_id && debug.data.app_id !== this.env.META_APP_ID) {
        throw new BadRequestException({
          code: "meta_app_mismatch",
          message: "Meta OAuth token was issued for a different app",
        });
      }

      return {
        userToken: token.access_token,
        tokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : null,
        debug,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        code: "meta_oauth_failed",
        message: "Could not complete Meta OAuth",
      });
    }
  }

  private async getManagedPages(userToken: string) {
    try {
      return (await this.graph.getManagedPages(userToken)).data ?? [];
    } catch {
      throw new BadRequestException({
        code: "meta_pages_failed",
        message: "Could not fetch Meta managed pages",
      });
    }
  }

  private async buildConnectionRows(input: {
    page: MetaManagedPage;
    userToken: string;
    orgId: string;
    userId: string;
    tokenExpiresAt: string | null;
    debug: MetaDebugTokenResponse;
    now: string;
  }): Promise<ChannelConnectionUpsert[]> {
    const pageToken = await this.getPageToken(input.page, input.userToken);
    const encryptedToken = encryptToken(
      pageToken,
      this.env.TOKEN_ENCRYPTION_KEY,
    );
    const instagramBusinessAccountId =
      input.page.instagram_business_account?.id ?? null;
    const baseMetadata = {
      pageName: input.page.name,
      connectedByUserId: input.userId,
      metaUserId: input.debug.data.user_id ?? null,
      scopes: input.debug.data.scopes ?? [],
    };
    const base = {
      org_id: input.orgId,
      external_page_id: input.page.id,
      access_token_enc: encryptedToken,
      refresh_token_enc: null,
      token_expires_at: input.tokenExpiresAt,
      status: "active",
      updated_at: input.now,
    } satisfies Omit<
      ChannelConnectionUpsert,
      "provider" | "external_ig_id" | "metadata_json"
    >;

    const rows: ChannelConnectionUpsert[] = [
      {
        ...base,
        provider: "meta_page",
        external_ig_id: instagramBusinessAccountId,
        metadata_json: {
          ...baseMetadata,
          instagramBusinessAccountId,
        },
      },
    ];

    if (instagramBusinessAccountId) {
      rows.push({
        ...base,
        provider: "meta_ig",
        external_ig_id: instagramBusinessAccountId,
        metadata_json: {
          ...baseMetadata,
          instagramBusinessAccountId,
        },
      });
    }

    return rows;
  }

  private async ensureWithinMaxPages(
    orgId: string,
    rows: ChannelConnectionUpsert[],
  ) {
    if (!this.entitlements) {
      return;
    }

    const entitlements = await this.entitlements.getEntitlements(orgId);
    const maxPages = entitlements.maxPages;
    const { data, error } = await this.supabase
      .from("channel_connections")
      .select(CHANNEL_SELECT)
      .eq("org_id", orgId)
      .eq("status", "active");

    if (error) {
      throwChannelsError(error, "Could not count active channel connections");
    }

    const active = (data ?? []) as ChannelConnectionRow[];
    const activeKeys = new Set(active.map(connectionKey));
    const newActiveCount = rows.filter((row) => !activeKeys.has(connectionKey(row)))
      .length;

    if (active.length + newActiveCount > maxPages) {
      throw new ForbiddenException({
        code: "max_pages_exceeded",
        message: "Plan max_pages entitlement would be exceeded",
      });
    }
  }

  private async getPageToken(page: MetaManagedPage, userToken: string) {
    if (page.access_token) {
      return page.access_token;
    }

    try {
      return (await this.graph.getPageAccessToken(page.id, userToken))
        .access_token;
    } catch {
      throw new BadRequestException({
        code: "meta_page_token_failed",
        message: "Could not fetch Meta page access token",
      });
    }
  }
}

function mapConnection(row: ChannelConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    externalPageId: row.external_page_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

function connectionKey(row: Pick<ChannelConnectionRow, "provider" | "external_page_id">) {
  return `${row.provider}:${row.external_page_id}`;
}

function throwChannelsError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "channels_failed",
    message,
  });
}

function throwInvalidOAuthState(): never {
  throw new BadRequestException({
    code: "meta_oauth_state_invalid",
    message: "Meta OAuth state is invalid or expired",
  });
}

function createSupabaseServiceClient(env: ChannelsEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
