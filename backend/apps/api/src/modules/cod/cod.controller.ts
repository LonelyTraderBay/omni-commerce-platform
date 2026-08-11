import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import { CodService } from './cod.service';
import {
  ReconcileCodBatchBodySchema,
  ReconcileCodOrderBodySchema,
  RecordCodCollectionBodySchema,
} from './dto';

@Controller('v1/cod')
@UseGuards(PermissionsGuard)
export class CodController {
  constructor(private readonly cod: CodService) {}

  @Get('report')
  @RequirePermission('orders.read')
  getReport(@OrgId() orgId: string | undefined) {
    return this.cod.getReport(requireOrgId(orgId));
  }

  @Post('collections')
  @RequirePermission('orders.write')
  recordCollection(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.cod.recordCollection({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(RecordCodCollectionBodySchema, body),
    });
  }

  @Post('reconcile')
  @HttpCode(200)
  @RequirePermission('orders.write')
  reconcileOrder(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    const parsed = parseBody(ReconcileCodOrderBodySchema, body);
    return this.cod.reconcileOrder({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      orderId: parsed.orderId,
    });
  }

  @Post('reconcile/batch')
  @HttpCode(200)
  @RequirePermission('orders.write')
  reconcileBatch(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.cod.reconcileBatch({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(ReconcileCodBatchBodySchema, body),
    });
  }
}

function parseBody<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  body: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      message: 'Request body is invalid',
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

function requireUserId(user: AuthenticatedUser | undefined) {
  if (!user?.id) {
    throw new UnauthorizedException({
      code: 'user_required',
      message: 'Authenticated user is required',
    });
  }

  return user.id;
}
