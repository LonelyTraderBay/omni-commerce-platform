import { Body, Controller, Post, UseGuards } from "@nestjs/common";

import { ServiceKeyGuard } from "../../common/guards/service-key.guard";
import { ToolsRateLimitGuard } from "../../common/guards/tools-rate-limit.guard";
import {
  AiToolsService,
  parseCreateDraftOrderToolBody,
  parseGetProductToolBody,
} from "./ai-tools.service";

@Controller("internal/v1/tools")
@UseGuards(ServiceKeyGuard, ToolsRateLimitGuard)
export class AiToolsController {
  constructor(private readonly aiTools: AiToolsService) {}

  @Post("get-product")
  getProduct(@Body() body: unknown) {
    return this.aiTools.getProduct(parseGetProductToolBody(body));
  }

  @Post("create-draft-order")
  createDraftOrder(@Body() body: unknown) {
    return this.aiTools.createDraftOrder(parseCreateDraftOrderToolBody(body));
  }
}
