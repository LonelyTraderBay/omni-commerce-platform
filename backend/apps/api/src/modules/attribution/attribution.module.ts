import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { AttributionController } from './attribution.controller';
import { AttributionService } from './attribution.service';

@Module({
  controllers: [AttributionController],
  providers: [AttributionService, PermissionsGuard],
})
export class AttributionModule {}
