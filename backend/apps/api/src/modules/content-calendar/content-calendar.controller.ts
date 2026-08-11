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
import { ContentCalendarService } from './content-calendar.service';
import {
  CreateContentCalendarItemBodySchema,
  ListContentCalendarQuerySchema,
  UpdateContentCalendarItemBodySchema,
} from './dto';

@Controller('v1/content-calendar')
@UseGuards(PermissionsGuard)
export class ContentCalendarController {
  constructor(private readonly calendar: ContentCalendarService) {}

  @Get()
  @RequirePermission('orders.read')
  listItems(@OrgId() orgId: string | undefined, @Query() query: unknown) {
    return this.calendar.listItems(
      requireOrgId(orgId),
      parseBody(ListContentCalendarQuerySchema, query),
    );
  }

  @Post()
  @RequirePermission('org.settings.write')
  createItem(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.calendar.createItem({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      body: parseBody(CreateContentCalendarItemBodySchema, body),
    });
  }

  @Patch(':itemId')
  @RequirePermission('org.settings.write')
  updateItem(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: unknown,
  ) {
    return this.calendar.updateItem({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      itemId,
      body: parseBody(UpdateContentCalendarItemBodySchema, body),
    });
  }

  @Delete(':itemId')
  @RequirePermission('org.settings.write')
  deleteItem(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.calendar.deleteItem({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      itemId,
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
