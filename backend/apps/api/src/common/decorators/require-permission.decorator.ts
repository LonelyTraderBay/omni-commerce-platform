import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@omni/authz-types";

export const PERMISSION_KEY = "permission";

export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
