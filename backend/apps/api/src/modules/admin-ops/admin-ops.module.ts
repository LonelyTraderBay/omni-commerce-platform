import { Module } from "@nestjs/common";

import {
  PLATFORM_ADMINS_REPOSITORY,
  PlatformAdminGuard,
  SupabasePlatformAdminsRepository,
} from "../../common/guards/platform-admin.guard";
import { AuditService } from "../audit/audit.service";
import { BillingModule } from "../billing/billing.module";
import { AdminOpsController } from "./admin-ops.controller";
import { AdminOpsService } from "./admin-ops.service";

@Module({
  imports: [BillingModule],
  controllers: [AdminOpsController],
  providers: [
    AdminOpsService,
    AuditService,
    PlatformAdminGuard,
    {
      provide: PLATFORM_ADMINS_REPOSITORY,
      useClass: SupabasePlatformAdminsRepository,
    },
  ],
})
export class AdminOpsModule {}
