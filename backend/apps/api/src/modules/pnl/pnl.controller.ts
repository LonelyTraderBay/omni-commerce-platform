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
import { PnlDateRangeQuerySchema } from './dto';
import { PnlService } from './pnl.service';

@Controller('v1/pnl')
@UseGuards(PermissionsGuard)
export class PnlController {
  constructor(private readonly pnl: PnlService) {}

  @Get('summary')
  @RequirePermission('orders.read')
  getSummary(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    return this.pnl.getSummary(
      requireOrgId(orgId),
      parseQuery(PnlDateRangeQuerySchema, query),
    );
  }

  @Get('by-sku')
  @RequirePermission('orders.read')
  getBySku(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    return this.pnl.getBySku(
      requireOrgId(orgId),
      parseQuery(PnlDateRangeQuerySchema, query),
    );
  }
}

function parseQuery<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  query: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      message: 'Request query is invalid',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function requireOrgId(orgId: string | undefined) {
  if (!orgId) {
    throw new BadRequestException({
      code: 'missing_org_context',
      message: 'Organization context is required',
    });
  }

  return orgId;
}
