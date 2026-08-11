import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
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
  CreateApiKeyBodySchema,
  CreateOutboundWebhookBodySchema,
  ListPublicOrdersQuerySchema,
  UpdateOutboundWebhookBodySchema,
} from './dto';
import {
  PublicApiKeyGuard,
  type PublicApiRequest,
} from './public-api-key.guard';
import { PublicApiService } from './public-api.service';

@Controller('v1/public-api')
@UseGuards(PermissionsGuard)
export class PublicApiManagementController {
  constructor(private readonly publicApi: PublicApiService) {}

  @Get('keys')
  @RequirePermission('public_api.keys.manage')
  listKeys(@OrgId() orgId: string | undefined) {
    return this.publicApi.listKeys(requireOrgId(orgId));
  }

  @Post('keys')
  @RequirePermission('public_api.keys.manage')
  createKey(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.publicApi.createKey({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(CreateApiKeyBodySchema, body),
    });
  }

  @Post('keys/:keyId/revoke')
  @RequirePermission('public_api.keys.manage')
  revokeKey(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ) {
    return this.publicApi.revokeKey({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      keyId,
    });
  }

  @Get('webhooks')
  @RequirePermission('public_api.keys.manage')
  listWebhooks(@OrgId() orgId: string | undefined) {
    return this.publicApi.listWebhooks(requireOrgId(orgId));
  }

  @Post('webhooks')
  @RequirePermission('public_api.keys.manage')
  createWebhook(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.publicApi.createWebhook({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(CreateOutboundWebhookBodySchema, body),
    });
  }

  @Patch('webhooks/:webhookId')
  @RequirePermission('public_api.keys.manage')
  updateWebhook(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @Body() body: unknown,
  ) {
    return this.publicApi.updateWebhook({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      webhookId,
      body: parseBody(UpdateOutboundWebhookBodySchema, body),
    });
  }

  @Post('webhooks/:webhookId/test')
  @RequirePermission('public_api.keys.manage')
  testWebhook(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
  ) {
    return this.publicApi.testWebhook({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      webhookId,
    });
  }
}

@Controller('public/v1/orders')
@UseGuards(PublicApiKeyGuard)
export class PublicOrdersController {
  constructor(private readonly publicApi: PublicApiService) {}

  @Get()
  listOrders(@Req() request: PublicApiRequest, @Query() query: unknown) {
    const auth = request.publicApi;
    if (!auth) {
      throw new UnauthorizedException({
        code: 'public_api_key_required',
        message: 'A valid omni_ API key is required',
      });
    }
    return this.publicApi.listPublicOrders(
      auth.orgId,
      parseBody(ListPublicOrdersQuerySchema, query),
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

function requireUserId(user: AuthenticatedUser | undefined) {
  if (!user?.id) {
    throw new UnauthorizedException({
      code: 'user_required',
      message: 'Authenticated user is required',
    });
  }

  return user.id;
}
