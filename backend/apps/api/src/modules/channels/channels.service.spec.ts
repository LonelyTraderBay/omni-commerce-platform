import { describe, expect, it, vi } from "vitest";

import { decryptToken } from "../../common/crypto/token-crypto";
import {
  ChannelsService,
  type ChannelsEnv,
  type GraphLike,
  type SupabaseLike,
} from "./channels.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ORG_2_ID = "11111111-1111-1111-1111-111111111112";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const CONNECTION_ID = "33333333-3333-3333-3333-333333333333";
const TOKEN_KEY = "dev-token-encryption-key-32chars!!";

const env = {
  META_APP_ID: "meta-app-id",
  META_APP_SECRET: "meta-secret",
  META_REDIRECT_URI: "https://app.example.com/meta/callback",
  META_GRAPH_VERSION: "v21.0",
  SUPABASE_URL: "https://supabase.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
} satisfies ChannelsEnv;

function graphMock(overrides: Partial<GraphLike> = {}) {
  return {
    exchangeCodeForToken: async () => ({
      access_token: "USER_TOKEN",
      expires_in: 3600,
    }),
    debugToken: async () => ({
      data: {
        app_id: env.META_APP_ID,
        is_valid: true,
        scopes: ["pages_show_list"],
        user_id: "meta-user-1",
      },
    }),
    getManagedPages: async () => ({
      data: [
        {
          id: "page-1",
          name: "Shop Page",
          access_token: "EAAB_PLAIN",
        },
      ],
    }),
    getPageAccessToken: async () => ({
      id: "page-1",
      access_token: "EAAB_PLAIN",
    }),
    ...overrides,
  } satisfies GraphLike;
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    org_id: ORG_ID,
    provider: "meta_page",
    external_page_id: "page-1",
    external_ig_id: null,
    status: "active",
    created_at: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

type OAuthStateRow = {
  expires_at: string;
  org_id: string;
  state: string;
  user_id: string;
};

function oauthState(overrides: Partial<OAuthStateRow> = {}): OAuthStateRow {
  return {
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    org_id: ORG_ID,
    state: "oauth-state-1",
    user_id: USER_ID,
    ...overrides,
  };
}

function channelsSupabaseMock(input: {
  connectionRows?: unknown[];
  activeRows?: unknown[];
  oauthStates?: OAuthStateRow[];
} = {}) {
  const inserts: unknown[] = [];
  const upserts: unknown[] = [];
  const oauthStates = [...(input.oauthStates ?? [])];
  const client = {
    from(table: string) {
      if (table === "oauth_states") {
        return {
          insert(values: unknown) {
            inserts.push({ table, values });
            oauthStates.push(values as OAuthStateRow);
            return { error: null };
          },
          delete() {
            const filters: Array<{ field: keyof OAuthStateRow; value: string }> =
              [];
            let expiresAfter = "";
            const query = {
              eq(field: keyof OAuthStateRow, value: string) {
                filters.push({ field, value });
                return query;
              },
              gt(field: keyof OAuthStateRow, value: string) {
                expect(field).toBe("expires_at");
                expiresAfter = value;
                return query;
              },
              select(columns: string) {
                expect(columns).toBe("state");
                return {
                  maybeSingle: async () => {
                    const index = oauthStates.findIndex(
                      (row) =>
                        filters.every(
                          (filter) => row[filter.field] === filter.value,
                        ) && row.expires_at > expiresAfter,
                    );
                    if (index === -1) {
                      return { data: null, error: null };
                    }

                    const [row] = oauthStates.splice(index, 1);
                    return { data: { state: row.state }, error: null };
                  },
                };
              },
            };
            return query;
          },
        };
      }

      if (table === "channel_connections") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq: async () => ({
                    data: input.activeRows ?? [],
                    error: null,
                  }),
                };
              },
            };
          },
          upsert(values: unknown, options: unknown) {
            upserts.push({ table, values, options });
            return {
              select: async () => ({
                data: input.connectionRows ?? [connectionRow()],
                error: null,
              }),
            };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseLike;

  return { client, inserts, oauthStates, upserts };
}

describe("ChannelsService", () => {
  it("builds a Meta OAuth URL with Phase 1 scopes and state", async () => {
    const { client, inserts } = channelsSupabaseMock();
    const service = new ChannelsService(
      client,
      graphMock(),
      undefined,
      env,
    );

    const result = await service.getMetaOAuthUrl({
      orgId: ORG_ID,
      userId: USER_ID,
    });
    const url = new URL(result.url);

    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v21.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe(env.META_APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(env.META_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toContain("pages_messaging");
    expect(url.searchParams.get("scope")).toContain(
      "instagram_manage_messages",
    );
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserts).toEqual([
      {
        table: "oauth_states",
        values: expect.objectContaining({
          org_id: ORG_ID,
          state: url.searchParams.get("state"),
          user_id: USER_ID,
        }),
      },
    ]);
  });

  it("stores encrypted token and omits secrets from DTO", async () => {
    const { client, upserts } = channelsSupabaseMock({
      oauthStates: [oauthState()],
    });
    const auditCalls: unknown[] = [];
    const service = new ChannelsService(
      client,
      graphMock(),
      {
        writeAudit: async (input) => {
          auditCalls.push(input);
          return { audit: { id: "audit-1" } };
        },
      },
      env,
    );

    const result = await service.completeOAuth({
      orgId: ORG_ID,
      userId: USER_ID,
      code: "x",
      state: "oauth-state-1",
    });

    expect(JSON.stringify(upserts)).not.toContain("EAAB_PLAIN");
    expect(JSON.stringify(result)).not.toContain("EAAB_PLAIN");
    expect(result).not.toHaveProperty("accessToken");
    expect(result.connections[0]).toMatchObject({
      provider: "meta_page",
      externalPageId: "page-1",
      status: "active",
    });
    const upsertRows = (upserts[0] as { values: unknown }).values as Array<{
      access_token_enc: string;
      metadata_json: Record<string, unknown>;
    }>;
    expect(decryptToken(upsertRows[0].access_token_enc, TOKEN_KEY)).toBe(
      "EAAB_PLAIN",
    );
    expect(upsertRows[0].metadata_json).not.toHaveProperty("accessToken");
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        actorUserId: USER_ID,
        actorType: "user",
        action: "channel.connected",
        entityType: "channel_connection",
        entityId: CONNECTION_ID,
        meta: {
          provider: "meta_page",
          externalPageId: "page-1",
          externalIgId: null,
        },
      },
    ]);
  });

  it("connects Zalo OA with encrypted token and no secret in DTO", async () => {
    const { client, upserts } = channelsSupabaseMock({
      connectionRows: [
        connectionRow({
          provider: "zalo_oa",
          external_page_id: "oa-1",
        }),
      ],
    });
    const auditCalls: unknown[] = [];
    const service = new ChannelsService(
      client,
      graphMock(),
      {
        writeAudit: async (input) => {
          auditCalls.push(input);
          return { audit: { id: "audit-1" } };
        },
      },
      env,
    );

    const result = await service.connectZalo({
      orgId: ORG_ID,
      userId: USER_ID,
      oaId: "oa-1",
      accessToken: "ZALO_PLAIN_TOKEN",
      displayName: "Zalo Shop",
    });

    expect(JSON.stringify(upserts)).not.toContain("ZALO_PLAIN_TOKEN");
    expect(JSON.stringify(result)).not.toContain("ZALO_PLAIN_TOKEN");
    expect(result.connection).toMatchObject({
      provider: "zalo_oa",
      externalPageId: "oa-1",
      status: "active",
    });
    const upsertRows = (upserts[0] as { values: unknown }).values as Array<{
      access_token_enc: string;
      metadata_json: Record<string, unknown>;
      provider: string;
    }>;
    expect(upsertRows[0]).toMatchObject({
      provider: "zalo_oa",
      metadata_json: {
        channel: "zalo",
        connectedByUserId: USER_ID,
        displayName: "Zalo Shop",
      },
    });
    expect(decryptToken(upsertRows[0].access_token_enc, TOKEN_KEY)).toBe(
      "ZALO_PLAIN_TOKEN",
    );
    expect(upsertRows[0].metadata_json).not.toHaveProperty("accessToken");
    expect(auditCalls).toEqual([
      {
        orgId: ORG_ID,
        actorUserId: USER_ID,
        actorType: "user",
        action: "channel.connected",
        entityType: "channel_connection",
        entityId: CONNECTION_ID,
        meta: {
          provider: "zalo_oa",
          externalPageId: "oa-1",
          externalIgId: null,
        },
      },
    ]);
  });

  it("rejects Meta connect when active channels would exceed max_pages", async () => {
    const { client, upserts } = channelsSupabaseMock({
      oauthStates: [oauthState()],
      activeRows: [connectionRow({ external_page_id: "page-existing" })],
    });
    const service = new ChannelsService(
      client,
      graphMock({
        getManagedPages: async () => ({
          data: [
            {
              id: "page-new",
              name: "New Shop Page",
              access_token: "EAAB_PLAIN",
            },
          ],
        }),
      }),
      undefined,
      env,
      {
        getEntitlements: async () => ({
          orgId: ORG_ID,
          maxPages: 1,
          aiMonthlyTokenLimit: 100_000,
          autoConfirmAllowed: false,
          updatedAt: "2026-07-24T10:00:00.000Z",
        }),
      },
    );

    await expect(
      service.completeOAuth({
        orgId: ORG_ID,
        userId: USER_ID,
        code: "x",
        state: "oauth-state-1",
      }),
    ).rejects.toMatchObject({
      response: { code: "max_pages_exceeded" },
      status: 403,
    });
    expect(upserts).toEqual([]);
  });

  it("rejects missing OAuth state before exchanging code", async () => {
    const exchangeCodeForToken = vi.fn();
    const service = new ChannelsService(
      channelsSupabaseMock().client,
      graphMock({ exchangeCodeForToken }),
      undefined,
      env,
    );

    await expect(
      service.completeOAuth({
        orgId: ORG_ID,
        userId: USER_ID,
        code: "x",
        state: " ",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("rejects invalid OAuth state before exchanging code", async () => {
    const exchangeCodeForToken = vi.fn();
    const service = new ChannelsService(
      channelsSupabaseMock().client,
      graphMock({ exchangeCodeForToken }),
      undefined,
      env,
    );

    await expect(
      service.completeOAuth({
        orgId: ORG_ID,
        userId: USER_ID,
        code: "x",
        state: "missing-state",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("rejects expired OAuth state before exchanging code", async () => {
    const exchangeCodeForToken = vi.fn();
    const service = new ChannelsService(
      channelsSupabaseMock({
        oauthStates: [
          oauthState({
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
      }).client,
      graphMock({ exchangeCodeForToken }),
      undefined,
      env,
    );

    await expect(
      service.completeOAuth({
        orgId: ORG_ID,
        userId: USER_ID,
        code: "x",
        state: "oauth-state-1",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("rejects OAuth state created for a different org", async () => {
    const exchangeCodeForToken = vi.fn();
    const service = new ChannelsService(
      channelsSupabaseMock({
        oauthStates: [oauthState({ org_id: ORG_2_ID })],
      }).client,
      graphMock({ exchangeCodeForToken }),
      undefined,
      env,
    );

    await expect(
      service.completeOAuth({
        orgId: ORG_ID,
        userId: USER_ID,
        code: "x",
        state: "oauth-state-1",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("lists channel connections without selecting or returning tokens", async () => {
    const selects: string[] = [];
    const client = {
      from(table: string) {
        return {
          select(columns: string) {
            selects.push(columns);
            return {
              eq(field: string, value: unknown) {
                expect({ table, field, value }).toEqual({
                  table: "channel_connections",
                  field: "org_id",
                  value: ORG_ID,
                });
                return {
                  order: async () => ({
                    data: [connectionRow()],
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseLike;
    const service = new ChannelsService(client, graphMock(), undefined, env);

    const result = await service.listConnections(ORG_ID);

    expect(selects.join(" ")).not.toContain("access_token");
    expect(JSON.stringify(result)).not.toContain("access_token");
    expect(result).toEqual([
      {
        id: CONNECTION_ID,
        provider: "meta_page",
        externalPageId: "page-1",
        status: "active",
        createdAt: "2026-07-24T10:00:00.000Z",
      },
    ]);
  });

  it("revokes a connection in the current org", async () => {
    const eqCalls: Array<{ field: string; value: unknown }> = [];
    const updates: unknown[] = [];
    const revokedAt = new Date("2026-07-24T11:00:00.000Z");
    const client = {
      from(table: string) {
        return {
          update(values: unknown) {
            expect(table).toBe("channel_connections");
            updates.push(values);
            const query = {
              eq(field: string, value: unknown) {
                eqCalls.push({ field, value });
                return query;
              },
              select() {
                return {
                  maybeSingle: async () => ({
                    data: connectionRow({ status: "revoked" }),
                    error: null,
                  }),
                };
              },
            };
            return query;
          },
        };
      },
    } as unknown as SupabaseLike;
    const service = new ChannelsService(client, graphMock(), undefined, env);

    const result = await service.revokeConnection(
      ORG_ID,
      CONNECTION_ID,
      revokedAt,
    );

    expect(updates).toEqual([
      {
        status: "revoked",
        updated_at: revokedAt.toISOString(),
      },
    ]);
    expect(eqCalls).toEqual([
      { field: "id", value: CONNECTION_ID },
      { field: "org_id", value: ORG_ID },
    ]);
    expect(result.connection.status).toBe("revoked");
  });
});
