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
import { EinvoiceJobStatusSchema, IssueEinvoiceBodySchema } from './dto';
import { EinvoiceService } from './einvoice.service';

@Controller('v1/einvoice')
@UseGuards(PermissionsGuard)
export class EinvoiceController {
  constructor(private readonly einvoice: EinvoiceService) {}

  @Get('jobs')
  @RequirePermission('orders.read')
  listJobs(
    @OrgId() orgId: string | undefined,
    @Query('status') status: unknown,
  ) {
    const parsedStatus =
      status === undefined || status === ''
        ? undefined
        : parseBody(EinvoiceJobStatusSchema, status);
    return this.einvoice.listJobs(requireOrgId(orgId), parsedStatus);
  }

  @Post('issue')
  @RequirePermission('orders.write')
  issue(@OrgId() orgId: string | undefined, @Body() body: unknown) {
    return this.einvoice.issue(
      requireOrgId(orgId),
      parseBody(IssueEinvoiceBodySchema, body),
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
      message: parsed.error.issues[0]?.message ?? 'Invalid request',
      details: parsed.error.flatten(),
    });
  }
  return parsed.data;
}
