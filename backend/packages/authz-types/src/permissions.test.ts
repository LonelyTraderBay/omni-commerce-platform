// backend/packages/authz-types/src/permissions.test.ts
import { describe, expect, it } from "vitest";
import { PLATFORM_ADMIN_PERMISSIONS, roleHasPermission } from "./permissions";

describe("roleHasPermission", () => {
  it("owner can invite members", () => {
    expect(roleHasPermission("owner", "members.invite")).toBe(true);
  });
  it("cskh cannot invite members", () => {
    expect(roleHasPermission("cskh", "members.invite")).toBe(false);
  });
  it("kho cannot reply inbox", () => {
    expect(roleHasPermission("kho", "inbox.reply")).toBe(false);
  });
  it("owner and cskh can approve orders, kho cannot", () => {
    expect(roleHasPermission("owner", "orders.approve")).toBe(true);
    expect(roleHasPermission("cskh", "orders.approve")).toBe(true);
    expect(roleHasPermission("kho", "orders.approve")).toBe(false);
  });
  it("only owner can request PDPA export or deletion", () => {
    expect(roleHasPermission("owner", "org.pdpa.export")).toBe(true);
    expect(roleHasPermission("owner", "org.pdpa.delete_request")).toBe(true);
    expect(roleHasPermission("cskh", "org.pdpa.export")).toBe(false);
    expect(roleHasPermission("cskh", "org.pdpa.delete_request")).toBe(false);
    expect(roleHasPermission("kho", "org.pdpa.export")).toBe(false);
    expect(roleHasPermission("kho", "org.pdpa.delete_request")).toBe(false);
  });
  it("platform ops.suspend only via platform admin path later", () => {
    expect(roleHasPermission("owner", "ops.org.suspend")).toBe(false);
  });
});

describe("PLATFORM_ADMIN_PERMISSIONS", () => {
  it("includes ops.org.suspend", () => {
    expect(PLATFORM_ADMIN_PERMISSIONS).toContain("ops.org.suspend");
  });

  it("owner cannot ops.org.suspend via roleHasPermission", () => {
    expect(roleHasPermission("owner", "ops.org.suspend")).toBe(false);
  });
});
