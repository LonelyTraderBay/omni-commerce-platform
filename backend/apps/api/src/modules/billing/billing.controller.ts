import { BadRequestException, Controller, Get } from "@nestjs/common";

import { OrgId } from "../../common/decorators/org-id.decorator";
import { BillingService } from "./billing.service";

@Controller("v1/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("plan")
  getPlan(@OrgId() orgId: string | undefined) {
    return this.billing.getPlan(requireOrgId(orgId));
  }

  @Get("usage")
  getUsage(@OrgId() orgId: string | undefined) {
    return this.billing.getUsage(requireOrgId(orgId));
  }

  @Get("invoices")
  listInvoices(@OrgId() orgId: string | undefined) {
    return this.billing.listInvoices(requireOrgId(orgId));
  }
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
