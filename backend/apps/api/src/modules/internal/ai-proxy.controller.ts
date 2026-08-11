import { Controller, Get, Req, UseGuards } from "@nestjs/common";

import { ServiceKeyGuard } from "../../common/guards/service-key.guard";
import type { RequestWithTraceparent } from "../../common/middleware/traceparent.middleware";
import { AiProxyService } from "./ai-proxy.service";

@Controller("internal/v1/ai")
@UseGuards(ServiceKeyGuard)
export class AiProxyController {
  constructor(private readonly aiProxy: AiProxyService) {}

  @Get("health")
  health(@Req() request: RequestWithTraceparent) {
    return this.aiProxy.checkAiHealth(request.traceparent);
  }
}
