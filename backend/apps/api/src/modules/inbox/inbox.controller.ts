import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { SendInboxMessageBodySchema } from './dto';
import { InboxService } from './inbox.service';

@Controller('v1/inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('conversations')
  @UseGuards(PermissionsGuard)
  @RequirePermission('inbox.read')
  listConversations(@OrgId() orgId: string | undefined) {
    return this.inbox.listConversations(requireOrgId(orgId));
  }

  @Get('conversations/:id/messages')
  @UseGuards(PermissionsGuard)
  @RequirePermission('inbox.read')
  listMessages(
    @OrgId() orgId: string | undefined,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.listMessages(requireOrgId(orgId), conversationId);
  }

  @Post('conversations/:id/messages')
  @UseGuards(PermissionsGuard)
  @RequirePermission('inbox.reply')
  sendMessage(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: unknown,
  ) {
    return this.inbox.sendMessage({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      conversationId,
      body: parseBody(SendInboxMessageBodySchema, body),
    });
  }

  @Post('conversations/:id/takeover')
  @UseGuards(PermissionsGuard)
  @RequirePermission('inbox.takeover')
  takeoverConversation(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.takeoverConversation({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      conversationId,
    });
  }

  @Post('conversations/:id/resume')
  @UseGuards(PermissionsGuard)
  @RequirePermission('inbox.takeover')
  resumeConversation(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.resumeConversation({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
      conversationId,
    });
  }
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
