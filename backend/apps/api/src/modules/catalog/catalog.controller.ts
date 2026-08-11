import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';

import { OrgId } from '../../common/decorators/org-id.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../authz/permissions.guard';
import { CatalogService } from './catalog.service';
import {
  CreateProductBodySchema,
  CreateVariantBodySchema,
  UpdateProductBodySchema,
  UpdateVariantBodySchema,
} from './dto';

@Controller('v1/catalog/products')
@UseGuards(PermissionsGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission('catalog.read')
  listProducts(@OrgId() orgId: string | undefined) {
    return this.catalog.listProducts(requireOrgId(orgId));
  }

  @Get(':productId')
  @RequirePermission('catalog.read')
  getProduct(
    @OrgId() orgId: string | undefined,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.getProduct(requireOrgId(orgId), productId);
  }

  @Post()
  @RequirePermission('catalog.write')
  createProduct(@OrgId() orgId: string | undefined, @Body() body: unknown) {
    return this.catalog.createProduct(
      requireOrgId(orgId),
      parseBody(CreateProductBodySchema, body),
    );
  }

  @Patch(':productId')
  @RequirePermission('catalog.write')
  updateProduct(
    @OrgId() orgId: string | undefined,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateProduct(
      requireOrgId(orgId),
      productId,
      parseBody(UpdateProductBodySchema, body),
    );
  }

  @Delete(':productId')
  @RequirePermission('catalog.write')
  deleteProduct(
    @OrgId() orgId: string | undefined,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.catalog.deleteProduct(requireOrgId(orgId), productId);
  }

  @Post(':productId/variants')
  @RequirePermission('catalog.write')
  createVariant(
    @OrgId() orgId: string | undefined,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.createVariant(
      requireOrgId(orgId),
      productId,
      parseBody(CreateVariantBodySchema, body),
    );
  }

  @Patch(':productId/variants/:variantId')
  @RequirePermission('catalog.write')
  updateVariant(
    @OrgId() orgId: string | undefined,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateVariant(
      requireOrgId(orgId),
      productId,
      variantId,
      parseBody(UpdateVariantBodySchema, body),
    );
  }

  @Delete(':productId/variants/:variantId')
  @RequirePermission('catalog.write')
  deleteVariant(
    @OrgId() orgId: string | undefined,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.catalog.deleteVariant(
      requireOrgId(orgId),
      productId,
      variantId,
    );
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
