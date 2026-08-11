import { Module } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../authz/permissions.guard';
import {
  PublicApiManagementController,
  PublicOrdersController,
} from './public-api.controller';
import { PublicApiKeyGuard } from './public-api-key.guard';
import { PublicApiService } from './public-api.service';

@Module({
  controllers: [PublicApiManagementController, PublicOrdersController],
  providers: [
    PublicApiService,
    PublicApiKeyGuard,
    PermissionsGuard,
    AuditService,
  ],
})
export class PublicApiModule {}
