import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';

import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import { AdSpendService } from './ad-spend.service';
import {
  AdSpendSummaryQuerySchema,
  ImportAdSpendBodySchema,
  ListAdSpendQuerySchema,
} from './dto';

@Controller('v1/ad-spend')
@UseGuards(PermissionsGuard)
export class AdSpendController {
  constructor(private readonly adSpend: AdSpendService) {}

  @Post('import')
  @RequirePermission('org.settings.write')
  importRows(@OrgId() orgId: string | undefined, @Body() body: unknown) {
    return this.adSpend.importRows(
      requireOrgId(orgId),
      parseBody(ImportAdSpendBodySchema, body),
    );
  }

  @Get()
  @RequirePermission('orders.read')
  list(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    return this.adSpend.list(
      requireOrgId(orgId),
      parseBody(ListAdSpendQuerySchema, query),
    );
  }

  @Get('summary')
  @RequirePermission('orders.read')
  summary(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    return this.adSpend.summary(
      requireOrgId(orgId),
      parseBody(AdSpendSummaryQuerySchema, query),
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

function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'validation_error',
      message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      details: parsed.error.flatten(),
    });
  }
  return parsed.data;
}
