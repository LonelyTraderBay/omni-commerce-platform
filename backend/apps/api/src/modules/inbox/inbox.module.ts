import { Module } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../authz/permissions.guard';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  controllers: [InboxController],
  providers: [InboxService, PermissionsGuard, AuditService],
})
export class InboxModule {}
