import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, PermissionsGuard],
  exports: [InventoryService],
})
export class InventoryModule {}
