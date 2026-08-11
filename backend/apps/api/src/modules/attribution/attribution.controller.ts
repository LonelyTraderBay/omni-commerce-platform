import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';

import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import { AttributionService } from './attribution.service';
import { AttributionSummaryQuerySchema } from './dto';

@Controller('v1/attribution')
@UseGuards(PermissionsGuard)
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  @Get('summary')
  @RequirePermission('orders.read')
  summary(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    return this.attribution.summary(
      requireOrgId(orgId),
      parseQuery(AttributionSummaryQuerySchema, query),
    );
  }
}

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw new BadRequestException({
      code: 'org_required',
      message: 'X-Org-Id header is required',
    });
  }
  return orgId;
}

function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  query: unknown,
): z.output<T> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'validation_error',
      message: parsed.error.issues[0]?.message ?? 'Invalid query',
      details: parsed.error.flatten(),
    });
  }
  return parsed.data;
}
