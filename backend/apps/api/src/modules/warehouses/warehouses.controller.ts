import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
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
  CreateWarehouseBodySchema,
  TransferStockBodySchema,
} from './dto';
import { WarehousesService } from './warehouses.service';

@Controller('v1/warehouses')
@UseGuards(PermissionsGuard)
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequirePermission('catalog.read')
  listWarehouses(@OrgId() orgId: string | undefined) {
    return this.warehouses.listWarehouses(requireOrgId(orgId));
  }

  @Post()
  @RequirePermission('catalog.write')
  createWarehouse(
    @OrgId() orgId: string | undefined,
    @Body() body: unknown,
  ) {
    return this.warehouses.createWarehouse(
      requireOrgId(orgId),
      parseBody(CreateWarehouseBodySchema, body),
    );
  }

  @Get(':warehouseId/stock')
  @RequirePermission('catalog.read')
  getWarehouseStock(
    @OrgId() orgId: string | undefined,
    @Param('warehouseId') warehouseId: string,
  ) {
    return this.warehouses.getWarehouseStock(requireOrgId(orgId), warehouseId);
  }

  @Post('transfer')
  @RequirePermission('catalog.write')
  transferStock(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.warehouses.transferStock(
      requireOrgId(orgId),
      parseBody(TransferStockBodySchema, body),
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
