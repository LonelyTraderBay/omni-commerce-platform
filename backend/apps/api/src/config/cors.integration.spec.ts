import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCorsOptions } from "./cors";

/**
 * Regression test for the bug where backend/apps/api/src/main.ts never called
 * app.enableCors(...): every cross-origin browser call from the web app
 * (:4700) to the API (:4701) — i.e. the entire login/dashboard/catalog/
 * orders flow — was silently blocked at the CORS preflight (OPTIONS -> 404
 * -> ERR_FAILED). Existing tests (unit tests, infra/scripts/local-e2e-smoke.mjs)
 * all call the API via Node's `fetch`, which does not enforce CORS at all,
 * so none of them could ever catch this class of bug — only a real browser
 * (or, here, a real HTTP OPTIONS preflight) can.
 *
 * This boots a real Nest + Express HTTP server on an ephemeral port, wired
 * with app.enableCors(buildCorsOptions(...)) exactly as main.ts does, and
 * drives an actual preflight request against it with `fetch` (which, unlike
 * a browser, does not itself enforce CORS — so we assert on the response
 * headers directly, the same thing a browser's preflight check inspects).
 *
 * The route module below is a local stub rather than the real
 * IdentityModule: booting the full production module graph (or modules
 * with services that rely on implicit constructor-type DI rather than
 * explicit @Inject tokens) crashes under Vitest's esbuild-based transform,
 * which does not reliably emit `emitDecoratorMetadata` the way `tsc` does
 * (confirmed separately — the real API, built with tsc, boots fine). CORS
 * preflight handling is global Express middleware registered by
 * `enableCors` and runs before Nest's router/guards regardless of which
 * controllers are mounted, so a dependency-free stub at the same path is
 * exactly as faithful a regression test as the real controller would be.
 */

const WEB_ORIGIN = "http://127.0.0.1:4700";

@Controller("v1/orgs")
class OrgsRouteStub {
  @Get()
  list() {
    return { organizations: [] };
  }
}

@Module({ controllers: [OrgsRouteStub] })
class CorsTestModule {}

describe("CORS preflight (regression: API must call app.enableCors)", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;

  beforeEach(async () => {
    app = await NestFactory.create(CorsTestModule, { logger: false });
    app.enableCors(buildCorsOptions({ WEB_ORIGIN }));
    await app.listen(0, "127.0.0.1");

    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address ? address.port : address;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("answers an OPTIONS preflight from the configured web origin with matching CORS headers", async () => {
    const res = await fetch(`${baseUrl}/v1/orgs`, {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,x-org-id,content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);

    const allowedHeaders = (
      res.headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("x-org-id");
  });

  it("does not grant a different origin the same Access-Control-Allow-Origin (allow-list, not a wildcard)", async () => {
    const res = await fetch(`${baseUrl}/v1/orgs`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });

    const allowOrigin = res.headers.get("access-control-allow-origin");
    expect(allowOrigin).not.toBe("https://evil.example");
    expect(allowOrigin).not.toBe("*");
    expect(allowOrigin).toBe(WEB_ORIGIN);
  });

  it("a plain GET request (not a browser CORS scenario) still reaches the real route", async () => {
    const res = await fetch(`${baseUrl}/v1/orgs`, {
      headers: { Origin: WEB_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizations: [] });
  });
});
