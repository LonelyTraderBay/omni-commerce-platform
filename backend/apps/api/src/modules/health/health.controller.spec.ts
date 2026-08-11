import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("returns ok", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const controller = moduleRef.get(HealthController);
    expect(controller.health()).toEqual({ status: "ok" });
  });

  it("returns ready", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const controller = moduleRef.get(HealthController);
    expect(controller.ready()).toEqual({ status: "ready" });
  });

  it("returns SSO availability placeholder", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const controller = moduleRef.get(HealthController);
    expect(controller.ssoStatus()).toEqual({ available: false, etaDays: 90 });
  });
});
