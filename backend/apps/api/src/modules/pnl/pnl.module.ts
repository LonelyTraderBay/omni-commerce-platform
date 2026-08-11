import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { PnlController } from './pnl.controller';
import { PnlService } from './pnl.service';

@Module({
  controllers: [PnlController],
  providers: [PnlService, PermissionsGuard],
})
export class PnlModule {}
