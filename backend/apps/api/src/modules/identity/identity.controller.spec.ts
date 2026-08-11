import { describe, expect, it, vi } from "vitest";

import { PERMISSION_KEY } from "../../common/decorators/require-permission.decorator";
import { IdentityController } from "./identity.controller";
import { type IdentityService } from "./identity.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "99999999-9999-9999-9999-999999999999";

describe("IdentityController updateSettings", () => {
  it("delegates PATCH /v1/orgs/:orgId/settings to the service with the parsed body", async () => {
    const service = {
      updateOrgSettings: vi.fn(async () => ({
        organization: {
          id: ORG_ID,
          settingsJson: { auto_confirm: true },
        },
      })),
    } as unknown as IdentityService;
    const controller = new IdentityController(service);

    const result = await controller.updateSettings(ORG_ID, ORG_ID, {
      autoConfirm: true,
    });

    expect(service.updateOrgSettings).toHaveBeenCalledWith(ORG_ID, {
      autoConfirm: true,
    });
    expect(result).toEqual({
      organization: { id: ORG_ID, settingsJson: { auto_confirm: true } },
    });
  });

  it("rejects a body with no recognized fields before ever reaching the service", () => {
    const service = {
      updateOrgSettings: vi.fn(),
    } as unknown as IdentityService;
    const controller = new IdentityController(service);

    let thrown: unknown;
    try {
      controller.updateSettings(ORG_ID, ORG_ID, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      response: expect.objectContaining({ code: "invalid_request" }),
      status: 400,
    });
    expect(service.updateOrgSettings).not.toHaveBeenCalled();
  });

  it("rejects when the :orgId path param does not match the X-Org-Id-derived context", () => {
    const service = {
      updateOrgSettings: vi.fn(),
    } as unknown as IdentityService;
    const controller = new IdentityController(service);

    let thrown: unknown;
    try {
      controller.updateSettings(ORG_ID, OTHER_ORG_ID, { autoConfirm: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      response: expect.objectContaining({ code: "org_context_mismatch" }),
      status: 400,
    });
    expect(service.updateOrgSettings).not.toHaveBeenCalled();
  });

  it("requires org.settings.write — granted only to owner in the authz matrix", () => {
    const permission = Reflect.getMetadata(
      PERMISSION_KEY,
      IdentityController.prototype.updateSettings,
    );

    expect(permission).toBe("org.settings.write");
  });
});
