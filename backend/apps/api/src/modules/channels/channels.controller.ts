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
} from "@nestjs/common";
import type { z } from "zod";

import {
  CurrentUser,
  type AuthenticatedUser,
} from "../../common/decorators/current-user.decorator";
import { OrgId } from "../../common/decorators/org-id.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { PermissionsGuard } from "../authz/permissions.guard";
import { ChannelsService } from "./channels.service";
import { CompleteMetaOAuthBodySchema, ConnectZaloBodySchema } from "./dto";

@Controller("v1/channels")
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get("meta/oauth-url")
  @UseGuards(PermissionsGuard)
  @RequirePermission("channels.connect")
  getMetaOAuthUrl(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.channels.getMetaOAuthUrl({
      orgId: requireOrgId(orgId),
      userId: requireUserId(user),
    });
  }

  @Post("meta/complete")
  @UseGuards(PermissionsGuard)
  @RequirePermission("channels.connect")
  completeMetaOAuth(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    const parsedBody = parseBody(CompleteMetaOAuthBodySchema, body);
    return this.channels.completeOAuth({
      orgId: requireOrgId(orgId),
      userId: requireUserId(user),
      code: parsedBody.code,
      state: parsedBody.state,
    });
  }

  @Post("zalo/connect")
  @UseGuards(PermissionsGuard)
  @RequirePermission("channels.connect")
  connectZalo(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    const parsedBody = parseBody(ConnectZaloBodySchema, body);
    return this.channels.connectZalo({
      orgId: requireOrgId(orgId),
      userId: requireUserId(user),
      oaId: parsedBody.oaId,
      accessToken: parsedBody.accessToken,
      displayName: parsedBody.displayName,
    });
  }

  @Get()
  listChannels(@OrgId() orgId: string | undefined) {
    return this.channels.listConnections(requireOrgId(orgId));
  }

  @Post(":id/revoke")
  @UseGuards(PermissionsGuard)
  @RequirePermission("channels.connect")
  revokeChannel(
    @OrgId() orgId: string | undefined,
    @Param("id", ParseUUIDPipe) connectionId: string,
  ) {
    return this.channels.revokeConnection(requireOrgId(orgId), connectionId);
  }
}

function parseBody<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  body: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: "invalid_request",
      message: "Request body is invalid",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function requireOrgId(orgId: string | undefined) {
  if (!orgId) {
    throw new BadRequestException({
      code: "missing_org_context",
      message: "Organization context is required",
    });
  }

  return orgId;
}

function requireUserId(user: AuthenticatedUser | undefined) {
  if (!user?.id) {
    throw new UnauthorizedException({
      code: "user_required",
      message: "Authenticated user is required",
    });
  }

  return user.id;
}
