import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  PlatformAdminGuard,
  type PlatformAdminsRepository,
} from "./platform-admin.guard";

type MockRequest = {
  user?: { id: string; email?: string };
};

function mockContext(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

function mockPlatformAdmins(isAdmin: boolean): PlatformAdminsRepository {
  return {
    isPlatformAdmin: async () => isAdmin,
  };
}

describe("PlatformAdminGuard", () => {
  it("rejects an owner JWT user who is not in platform_admins", async () => {
    const guard = new PlatformAdminGuard(mockPlatformAdmins(false));

    await expect(
      guard.canActivate(
        mockContext({
          user: { id: "owner-user-id", email: "owner@example.com" },
        }),
      ),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: "platform_admin_required" }),
    });
  });

  it("allows a user present in platform_admins", async () => {
    const guard = new PlatformAdminGuard(mockPlatformAdmins(true));

    await expect(
      guard.canActivate(mockContext({ user: { id: "admin-user-id" } })),
    ).resolves.toBe(true);
  });
});
