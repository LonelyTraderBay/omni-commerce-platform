import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import type { Membership } from "../../common/guards/org.guard";
import { PermissionsGuard } from "./permissions.guard";

type MockRequest = {
  membership?: Membership;
};

class InviteController {
  @RequirePermission("members.invite")
  createInvite() {}
}

function mockContext(
  request: MockRequest,
  handler: (...args: unknown[]) => unknown = InviteController.prototype.createInvite,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => InviteController,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

function membership(role: Membership["role"]): Membership {
  return {
    id: "m1",
    orgId: "11111111-1111-1111-1111-111111111111",
    userId: "u1",
    role,
  };
}

describe("PermissionsGuard", () => {
  it("allows owner for members.invite", () => {
    const guard = new PermissionsGuard(new Reflector());

    expect(
      guard.canActivate(
        mockContext({ membership: membership("owner") }),
      ),
    ).toBe(true);
  });

  it("rejects cskh for members.invite", () => {
    const guard = new PermissionsGuard(new Reflector());

    expect(() =>
      guard.canActivate(mockContext({ membership: membership("cskh") })),
    ).toThrowError(
      expect.objectContaining({
        status: 403,
        response: expect.objectContaining({ code: "permission_denied" }),
      }),
    );
  });

  it("passes through when no permission is required", () => {
    const guard = new PermissionsGuard(new Reflector());

    expect(
      guard.canActivate(
        mockContext({ membership: membership("cskh") }, () => {}),
      ),
    ).toBe(true);
  });
});
