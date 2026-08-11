import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  ready() {
    return { status: "ready" };
  }

  @Get("v1/auth/sso/status")
  ssoStatus() {
    return { available: false, etaDays: 90 };
  }
}
