import { Body, Controller, Post, UseGuards } from "@nestjs/common";

import { AiRunsService, parseWriteAiRunBody } from "../audit/ai-runs.service";
import { ServiceKeyGuard } from "../../common/guards/service-key.guard";

@Controller("internal/v1/ai")
@UseGuards(ServiceKeyGuard)
export class AiRunsController {
  constructor(private readonly aiRuns: AiRunsService) {}

  @Post("runs")
  writeRun(@Body() body: unknown) {
    return this.aiRuns.writeRun(parseWriteAiRunBody(body));
  }
}
