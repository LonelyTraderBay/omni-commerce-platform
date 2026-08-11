import { Module } from "@nestjs/common";

import { createGraphClientFromEnv } from "../../integrations/meta/graph.client";
import { AuditService } from "../audit/audit.service";
import { PermissionsGuard } from "../authz/permissions.guard";
import { BillingModule } from "../billing/billing.module";
import { ChannelsController } from "./channels.controller";
import { CHANNELS_GRAPH, ChannelsService } from "./channels.service";
import { MetaWebhookController } from "./meta-webhook.controller";
import { MetaWebhookService } from "./meta-webhook.service";
import { ZaloWebhookController } from "./zalo-webhook.controller";
import { ZaloWebhookService } from "./zalo-webhook.service";

@Module({
  imports: [BillingModule],
  controllers: [ChannelsController, MetaWebhookController, ZaloWebhookController],
  providers: [
    ChannelsService,
    MetaWebhookService,
    ZaloWebhookService,
    PermissionsGuard,
    AuditService,
    {
      provide: CHANNELS_GRAPH,
      useFactory: createGraphClientFromEnv,
    },
  ],
})
export class ChannelsModule {}
