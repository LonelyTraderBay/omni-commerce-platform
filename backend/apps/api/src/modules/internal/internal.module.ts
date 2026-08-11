import { Module } from "@nestjs/common";

import { ToolsRateLimitGuard } from "../../common/guards/tools-rate-limit.guard";
import { OutboxPublisher } from "../../jobs";
import { AiTokenUsageService } from "../billing/ai-token-usage.service";
import { AiRunsService } from "../audit/ai-runs.service";
import { AiRunsController } from "./ai-runs.controller";
import { AiTokenQuotaController } from "./ai-token-quota.controller";
import { AiProxyController } from "./ai-proxy.controller";
import { AiProxyService } from "./ai-proxy.service";
import { AiToolsController } from "./ai-tools.controller";
import { AiToolsService } from "./ai-tools.service";
import { KnowledgeIngestController } from "./knowledge-ingest.controller";
import { KnowledgeIngestService } from "./knowledge-ingest.service";
import { OutboxController } from "./outbox.controller";

@Module({
  controllers: [
    OutboxController,
    AiProxyController,
    AiRunsController,
    AiToolsController,
    AiTokenQuotaController,
    KnowledgeIngestController,
  ],
  providers: [
    ToolsRateLimitGuard,
    OutboxPublisher,
    AiProxyService,
    AiRunsService,
    AiTokenUsageService,
    AiToolsService,
    KnowledgeIngestService,
  ],
  exports: [OutboxPublisher],
})
export class InternalModule {}
