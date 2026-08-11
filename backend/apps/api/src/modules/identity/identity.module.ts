import { Module } from "@nestjs/common";

import { PermissionsGuard } from "../authz/permissions.guard";
import { AuditService } from "../audit/audit.service";
import { BillingModule } from "../billing/billing.module";
import { IdentityController, InvitesController } from "./identity.controller";
import { IdentityService } from "./identity.service";

@Module({
  imports: [BillingModule],
  controllers: [IdentityController, InvitesController],
  providers: [IdentityService, PermissionsGuard, AuditService],
})
export class IdentityModule {}
