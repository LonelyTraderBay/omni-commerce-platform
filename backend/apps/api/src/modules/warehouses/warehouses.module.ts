import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({
  controllers: [WarehousesController],
  providers: [WarehousesService, PermissionsGuard],
})
export class WarehousesModule {}
