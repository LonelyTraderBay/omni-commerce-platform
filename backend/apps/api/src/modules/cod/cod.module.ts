import { Module } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../authz/permissions.guard';
import { CodController } from './cod.controller';
import { CodService } from './cod.service';

@Module({
  controllers: [CodController],
  providers: [CodService, PermissionsGuard, AuditService],
  exports: [CodService],
})
export class CodModule {}
