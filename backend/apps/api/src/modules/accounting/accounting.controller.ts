import {
  BadRequestException,
  Controller,
  Get,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';

import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import { AccountingExportQuerySchema } from './dto';
import { AccountingService } from './accounting.service';

@Controller('v1/accounting')
@UseGuards(PermissionsGuard)
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get('export')
  @RequirePermission('orders.export')
  async export(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    const file = await this.accounting.export(
      requireOrgId(orgId),
      parseQuery(AccountingExportQuerySchema, query),
    );
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      disposition: `attachment; filename="${file.filename}"`,
    });
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
