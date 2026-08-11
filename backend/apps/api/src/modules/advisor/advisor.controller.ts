import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';

import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import { AdvisorService } from './advisor.service';
import { AdvisorSuggestBodySchema } from './dto';

@Controller('v1/advisor')
@UseGuards(PermissionsGuard)
export class AdvisorController {
  constructor(private readonly advisor: AdvisorService) {}

  @Post('suggest')
  @HttpCode(200)
  @RequirePermission('orders.read')
  suggest(@OrgId() orgId: string | undefined, @Body() body: unknown) {
    return this.advisor.suggest({
      orgId: requireOrgId(orgId),
      body: parseBody(AdvisorSuggestBodySchema, body),
    });
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
