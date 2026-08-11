import { describe, expect, it } from "vitest";

import { redactLogRecord } from "./redacting-logger";

describe("redactLogRecord", () => {
  it("redacts phone and token keys", () => {
    const out = redactLogRecord({
      phone: "+84901234567",
      authorization: "Bearer secret",
      orgId: "11111111-1111-1111-1111-111111111111",
    });
    expect(out.phone).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.orgId).toContain("11111111");
  });
});
