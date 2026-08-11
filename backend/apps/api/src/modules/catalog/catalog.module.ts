import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [InventoryModule],
  controllers: [CatalogController],
  providers: [CatalogService, PermissionsGuard],
})
export class CatalogModule {}
