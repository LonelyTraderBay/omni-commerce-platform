import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

type RequestWithOrg = {
  orgId?: string;
};

export const OrgId = createParamDecorator(
  (_field: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<RequestWithOrg>().orgId,
);
