import { describe, expect, it } from "vitest";

import { buildCorsOptions } from "./cors";

describe("buildCorsOptions", () => {
  it("scopes CORS to the configured WEB_ORIGIN and allows the headers the web app sends", () => {
    const options = buildCorsOptions({ WEB_ORIGIN: "http://127.0.0.1:4700" });

    expect(options.origin).toBe("http://127.0.0.1:4700");
    expect(options.methods).toEqual(["GET", "POST", "PATCH", "DELETE", "OPTIONS"]);
    expect(options.allowedHeaders).toEqual([
      "Content-Type",
      "Authorization",
      "X-Org-Id",
      "Idempotency-Key",
    ]);
  });

  it("never falls back to a wildcard origin", () => {
    const options = buildCorsOptions({ WEB_ORIGIN: "https://app.example.com" });

    expect(options.origin).toBe("https://app.example.com");
    expect(options.origin).not.toBe("*");
  });
});
