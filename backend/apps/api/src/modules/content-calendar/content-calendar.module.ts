import { Module } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../authz/permissions.guard';
import { ContentCalendarController } from './content-calendar.controller';
import { ContentCalendarService } from './content-calendar.service';

@Module({
  controllers: [ContentCalendarController],
  providers: [ContentCalendarService, PermissionsGuard, AuditService],
})
export class ContentCalendarModule {}
