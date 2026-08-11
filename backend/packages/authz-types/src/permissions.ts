// backend/packages/authz-types/src/permissions.ts
export type Role = "owner" | "cskh" | "kho";

export type Permission =
  | "org.settings.read"
  | "org.settings.write"
  | "org.pdpa.export"
  | "org.pdpa.delete_request"
  | "members.invite"
  | "channels.connect"
  | "catalog.read"
  | "catalog.write"
  | "inbox.read"
  | "inbox.reply"
  | "inbox.takeover"
  | "orders.read"
  | "orders.write"
  | "orders.approve"
  | "orders.export"
  | "public_api.keys.manage"
  | "ai.settings.write"
  | "ops.org.suspend"
  | "ops.global_flags";

export const PLATFORM_ADMIN_PERMISSIONS = [
  "ops.org.suspend",
  "ops.global_flags",
] as const satisfies readonly Permission[];

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: [
    "org.settings.read",
    "org.settings.write",
    "org.pdpa.export",
    "org.pdpa.delete_request",
    "members.invite",
    "channels.connect",
    "catalog.read",
    "catalog.write",
    "inbox.read",
    "inbox.reply",
    "inbox.takeover",
    "orders.read",
    "orders.write",
    "orders.approve",
    "orders.export",
    "public_api.keys.manage",
    "ai.settings.write",
  ],
  cskh: [
    "org.settings.read",
    "catalog.read",
    "inbox.read",
    "inbox.reply",
    "inbox.takeover",
    "orders.read",
    "orders.write",
    "orders.approve",
  ],
  kho: [
    "org.settings.read",
    "catalog.read",
    "inbox.read",
    "orders.read",
    "orders.write",
    "orders.export",
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}
