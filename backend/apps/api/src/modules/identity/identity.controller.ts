import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
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
import {
  AcceptInviteBodySchema,
  CreateInviteBodySchema,
  CreateOrgBodySchema,
  UpdateOrgSettingsBodySchema,
} from "./dto";
import { IdentityService } from "./identity.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("v1/orgs")
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post()
  createOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    return this.identity.createOrganization(
      user,
      parseBody(CreateOrgBodySchema, body),
    );
  }

  @Get()
  listOrganizations(
    @CurrentUser() user: AuthenticatedUser,
    @Headers("authorization") authorization: string | string[] | undefined,
  ) {
    return this.identity.listOrganizations(
      user,
      getBearerToken(authorization),
    );
  }

  @Get(":orgId/invites")
  @UseGuards(PermissionsGuard)
  @RequirePermission("members.invite")
  listInvites(
    @Param("orgId") orgId: string,
    @OrgId() guardOrgId: string | undefined,
  ) {
    assertOrgRouteMatchesGuard(orgId, guardOrgId);
    return this.identity.listInvites(orgId);
  }

  @Post(":orgId/invites")
  @UseGuards(PermissionsGuard)
  @RequirePermission("members.invite")
  createInvite(
    @Param("orgId") orgId: string,
    @OrgId() guardOrgId: string | undefined,
    @Body() body: unknown,
  ) {
    assertOrgRouteMatchesGuard(orgId, guardOrgId);
    return this.identity.createInvite(
      orgId,
      parseBody(CreateInviteBodySchema, body),
    );
  }

  @Patch(":orgId/settings")
  @UseGuards(PermissionsGuard)
  @RequirePermission("org.settings.write")
  updateSettings(
    @Param("orgId") orgId: string,
    @OrgId() guardOrgId: string | undefined,
    @Body() body: unknown,
  ) {
    assertOrgRouteMatchesGuard(orgId, guardOrgId);
    return this.identity.updateOrgSettings(
      orgId,
      parseBody(UpdateOrgSettingsBodySchema, body),
    );
  }

  @Post("me/export")
  @HttpCode(200)
  @UseGuards(PermissionsGuard)
  @RequirePermission("org.pdpa.export")
  exportOrganizationData(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.identity.exportOrganizationData({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
    });
  }

  @Post("me/delete-request")
  @HttpCode(202)
  @UseGuards(PermissionsGuard)
  @RequirePermission("org.pdpa.delete_request")
  requestOrganizationDelete(
    @OrgId() orgId: string | undefined,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.identity.requestOrganizationDelete({
      orgId: requireOrgId(orgId),
      actorUserId: requireUserId(user),
    });
  }
}

@Controller("v1/invites")
export class InvitesController {
  constructor(private readonly identity: IdentityService) {}

  @Post("accept")
  @HttpCode(200)
  acceptInvite(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ) {
    return this.identity.acceptInvite(
      { id: requireUserId(user), email: user?.email },
      parseBody(AcceptInviteBodySchema, body),
    );
  }
}

function assertOrgRouteMatchesGuard(
  orgId: string,
  guardOrgId: string | undefined,
) {
  if (!UUID_PATTERN.test(orgId)) {
    throw new BadRequestException({
      code: "invalid_org_id",
      message: "orgId route parameter must be a UUID",
    });
  }

  if (orgId !== guardOrgId) {
    throw new BadRequestException({
      code: "org_context_mismatch",
      message: "orgId route parameter must match X-Org-Id",
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

function getBearerToken(authorization: string | string[] | undefined) {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = header?.trim().match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    throw new UnauthorizedException({
      code: "bearer_required",
      message: "Bearer token is required",
    });
  }

  return token;
}
