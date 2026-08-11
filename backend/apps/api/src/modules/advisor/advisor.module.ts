import { Module } from '@nestjs/common';

import { AiRunsService } from '../audit/ai-runs.service';
import { PermissionsGuard } from '../authz/permissions.guard';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AdvisorController } from './advisor.controller';
import { AdvisorService } from './advisor.service';

@Module({
  imports: [FeatureFlagsModule],
  controllers: [AdvisorController],
  providers: [AdvisorService, AiRunsService, PermissionsGuard],
})
export class AdvisorModule {}
