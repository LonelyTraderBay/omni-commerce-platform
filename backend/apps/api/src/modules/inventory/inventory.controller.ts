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

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import {
  AdjustStockBodySchema,
  ListMovementsQuerySchema,
  LowStockQuerySchema,
} from './dto';
import { InventoryService } from './inventory.service';

@Controller('v1/inventory')
@UseGuards(PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('movements')
  @RequirePermission('catalog.read')
  listMovements(
    @OrgId() orgId: string | undefined,
    @Query() query: unknown,
  ) {
    return this.inventory.listMovements(
      requireOrgId(orgId),
      parseBody(ListMovementsQuerySchema, query),
    );
  }

  @Get('low-stock')
  @RequirePermission('catalog.read')
  listLowStock(
    @OrgId() orgId: string | undefined,
    @Query() query: unknown,
  ) {
    return this.inventory.listLowStock(
      requireOrgId(orgId),
      parseBody(LowStockQuerySchema, query),
    );
  }

  @Post('adjust')
  @RequirePermission('catalog.write')
  adjust(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.inventory.adjust(
      requireOrgId(orgId),
      parseBody(AdjustStockBodySchema, body),
      user?.id,
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
