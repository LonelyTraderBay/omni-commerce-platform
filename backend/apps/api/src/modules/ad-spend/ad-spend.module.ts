import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { AdSpendController } from './ad-spend.controller';
import { AdSpendService } from './ad-spend.service';

@Module({
  controllers: [AdSpendController],
  providers: [AdSpendService, PermissionsGuard],
  exports: [AdSpendService],
})
export class AdSpendModule {}
