import { Module } from "@nestjs/common";

import { AiTokenUsageService } from "./ai-token-usage.service";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { EntitlementsService } from "./entitlements.service";

@Module({
  controllers: [BillingController],
  providers: [AiTokenUsageService, BillingService, EntitlementsService],
  exports: [AiTokenUsageService, BillingService, EntitlementsService],
})
export class BillingModule {}
