import { Module } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../authz/permissions.guard';
import { CodModule } from '../cod/cod.module';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';

@Module({
  imports: [CodModule],
  controllers: [ShippingController],
  providers: [ShippingService, PermissionsGuard, AuditService],
})
export class ShippingModule {}
