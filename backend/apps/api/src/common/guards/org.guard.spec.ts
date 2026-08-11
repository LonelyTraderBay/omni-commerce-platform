import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { OrgGuard, type MembershipsRepository } from "./org.guard";

type MockRequest = {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  user?: { id: string; email?: string };
};

function mockContext(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

function mockMemberships(): MembershipsRepository {
  return {
    findMembership: async () => null,
  };
}

describe("OrgGuard", () => {
  it("skips POST /v1/orgs bootstrap route", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "POST",
          originalUrl: "/v1/orgs",
          user: { id: "u1" },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("skips GET /v1/orgs bootstrap route", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "GET",
          originalUrl: "/v1/orgs",
          user: { id: "u1" },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("skips the Inngest serve endpoint", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "POST",
          originalUrl: "/api/inngest",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("skips the Meta webhook endpoint", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "POST",
          originalUrl: "/v1/webhooks/meta",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("skips the Zalo webhook endpoint", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "POST",
          originalUrl: "/v1/channels/zalo/webhook",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("skips the public SSO status endpoint", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "GET",
          originalUrl: "/v1/auth/sso/status",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("rejects missing X-Org-Id", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(mockContext({ headers: {}, user: { id: "u1" } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not skip invite create route", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "POST",
          originalUrl: "/v1/orgs/11111111-1111-1111-1111-111111111111/invites",
          user: { id: "u1" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("skips invite accept route (no org membership yet)", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: {},
          method: "POST",
          originalUrl: "/v1/invites/accept",
          user: { id: "u1" },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("rejects membership miss", async () => {
    const guard = new OrgGuard(mockMemberships());

    await expect(
      guard.canActivate(
        mockContext({
          headers: { "x-org-id": "11111111-1111-1111-1111-111111111111" },
          user: { id: "u1" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
