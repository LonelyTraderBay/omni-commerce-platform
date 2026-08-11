import { describe, expect, it } from "vitest";
import { OrganizationSchema } from "./identity";

describe("OrganizationSchema", () => {
  it("defaults timezone and locale", () => {
    const org = OrganizationSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Shop A",
      slug: "shop-a",
      plan: "free_dev",
    });
    expect(org.timezone).toBe("Asia/Ho_Chi_Minh");
    expect(org.locale).toBe("vi");
  });
});
