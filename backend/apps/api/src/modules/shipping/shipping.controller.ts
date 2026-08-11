import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
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
import {
  CreateShipmentBodySchema,
  ListShipmentsQuerySchema,
  UpsertCarrierConnectionBodySchema,
} from './dto';
import { ShippingService } from './shipping.service';

@Controller('v1/shipping')
@UseGuards(PermissionsGuard)
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Get('connections')
  @RequirePermission('orders.read')
  listConnections(@OrgId() orgId: string | undefined) {
    return this.shipping.listConnections(requireOrgId(orgId));
  }

  @Post('connections')
  @RequirePermission('orders.write')
  upsertConnection(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.shipping.upsertConnection({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(UpsertCarrierConnectionBodySchema, body),
    });
  }

  @Post('shipments')
  @RequirePermission('orders.write')
  createShipment(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.shipping.createShipment({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(CreateShipmentBodySchema, body),
    });
  }

  @Get('shipments')
  @RequirePermission('orders.read')
  listShipments(
    @OrgId() orgId: string | undefined,
    @Query() query: unknown,
  ) {
    const parsed = parseBody(ListShipmentsQuerySchema, query);
    return this.shipping.listShipments(requireOrgId(orgId), parsed.orderId);
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
