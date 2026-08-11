import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { SupplierPoController } from './supplier-po.controller';
import { SupplierPoService } from './supplier-po.service';

@Module({
  controllers: [SupplierPoController],
  providers: [SupplierPoService, PermissionsGuard],
})
export class SupplierPoModule {}
