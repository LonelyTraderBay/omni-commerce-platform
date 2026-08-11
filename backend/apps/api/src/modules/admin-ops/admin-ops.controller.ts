import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { z } from "zod";

import { PlatformAdminGuard } from "../../common/guards/platform-admin.guard";
import {
  IssueInvoiceBodySchema,
  SetGlobalFlagBodySchema,
  UpdateOrgPlanBodySchema,
} from "./dto";
import { AdminOpsService } from "./admin-ops.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("ops/v1")
@UseGuards(PlatformAdminGuard)
export class AdminOpsController {
  constructor(private readonly adminOps: AdminOpsService) {}

  @Get("orgs")
  listOrganizations() {
    return this.adminOps.listOrganizations();
  }

  @Post("orgs/:orgId/suspend")
  suspendOrganization(@Param("orgId") orgId: string) {
    if (!UUID_PATTERN.test(orgId)) {
      throw new BadRequestException({
        code: "invalid_org_id",
        message: "orgId route parameter must be a UUID",
      });
    }

    return this.adminOps.suspendOrganization(orgId);
  }

  @Patch("orgs/:orgId/plan")
  updateOrganizationPlan(@Param("orgId") orgId: string, @Body() body: unknown) {
    if (!UUID_PATTERN.test(orgId)) {
      throw new BadRequestException({
        code: "invalid_org_id",
        message: "orgId route parameter must be a UUID",
      });
    }

    return this.adminOps.updateOrganizationPlan(
      orgId,
      parseBody(UpdateOrgPlanBodySchema, body),
    );
  }

  @Post("orgs/:orgId/invoices")
  issueInvoice(@Param("orgId") orgId: string, @Body() body: unknown) {
    if (!UUID_PATTERN.test(orgId)) {
      throw new BadRequestException({
        code: "invalid_org_id",
        message: "orgId route parameter must be a UUID",
      });
    }

    return this.adminOps.issueInvoice(
      orgId,
      parseBody(IssueInvoiceBodySchema, body),
    );
  }

  @Post("flags/:key")
  setGlobalFlag(@Param("key") key: string, @Body() body: unknown) {
    return this.adminOps.setGlobalFlag(
      key,
      parseBody(SetGlobalFlagBodySchema, body),
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
