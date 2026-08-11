import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';

@Module({
  controllers: [AccountingController],
  providers: [AccountingService, PermissionsGuard],
})
export class AccountingModule {}
