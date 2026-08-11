import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { roleHasPermission } from "@omni/authz-types";

import { PERMISSION_KEY } from "../../common/decorators/require-permission.decorator";
import type { Membership } from "../../common/guards/org.guard";

type RequestWithMembership = {
  membership?: Membership;
};

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const permission = this.reflector.getAllAndOverride<
      Parameters<typeof roleHasPermission>[1] | undefined
    >(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!permission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithMembership>();
    const role = request.membership?.role;
    if (!role || !roleHasPermission(role, permission)) {
      throw new ForbiddenException({
        code: "permission_denied",
        message: `Missing permission: ${permission}`,
      });
    }

    return true;
  }
}
