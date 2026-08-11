import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
  CreatePurchaseOrderBodySchema,
  CreateSupplierBodySchema,
  PurchaseOrderStatusSchema,
  ReceivePurchaseOrderBodySchema,
  UpdatePurchaseOrderStatusBodySchema,
} from './dto';
import { SupplierPoService } from './supplier-po.service';

@Controller('v1')
@UseGuards(PermissionsGuard)
export class SupplierPoController {
  constructor(private readonly supplierPo: SupplierPoService) {}

  @Get('suppliers')
  @RequirePermission('catalog.read')
  listSuppliers(@OrgId() orgId: string | undefined) {
    return this.supplierPo.listSuppliers(requireOrgId(orgId));
  }

  @Post('suppliers')
  @RequirePermission('catalog.write')
  createSupplier(
    @OrgId() orgId: string | undefined,
    @Body() body: unknown,
  ) {
    return this.supplierPo.createSupplier(
      requireOrgId(orgId),
      parseBody(CreateSupplierBodySchema, body),
    );
  }

  @Get('purchase-orders')
  @RequirePermission('catalog.read')
  listPurchaseOrders(
    @OrgId() orgId: string | undefined,
    @Query('status') status: unknown,
  ) {
    const parsedStatus =
      status === undefined || status === ''
        ? undefined
        : parseBody(PurchaseOrderStatusSchema, status);
    return this.supplierPo.listPurchaseOrders(
      requireOrgId(orgId),
      parsedStatus,
    );
  }

  @Post('purchase-orders')
  @RequirePermission('catalog.write')
  createPurchaseOrder(
    @OrgId() orgId: string | undefined,
    @Body() body: unknown,
  ) {
    return this.supplierPo.createPurchaseOrder(
      requireOrgId(orgId),
      parseBody(CreatePurchaseOrderBodySchema, body),
    );
  }

  @Patch('purchase-orders/:purchaseOrderId/status')
  @RequirePermission('catalog.write')
  updatePurchaseOrderStatus(
    @OrgId() orgId: string | undefined,
    @Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string,
    @Body() body: unknown,
  ) {
    return this.supplierPo.updatePurchaseOrderStatus(
      requireOrgId(orgId),
      purchaseOrderId,
      parseBody(UpdatePurchaseOrderStatusBodySchema, body),
    );
  }

  @Post('purchase-orders/:purchaseOrderId/receive')
  @HttpCode(200)
  @RequirePermission('catalog.write')
  receivePurchaseOrder(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('purchaseOrderId', ParseUUIDPipe) purchaseOrderId: string,
    @Body() body: unknown,
  ) {
    return this.supplierPo.receivePurchaseOrder(
      requireOrgId(orgId),
      purchaseOrderId,
      parseBody(ReceivePurchaseOrderBodySchema, body),
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
      message: parsed.error.issues[0]?.message ?? 'Invalid request',
      details: parsed.error.flatten(),
    });
  }
  return parsed.data;
}
