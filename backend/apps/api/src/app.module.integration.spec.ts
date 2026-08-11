import "reflect-metadata";

import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppModule } from "./app.module";

describe("AppModule (full module graph boot)", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "x".repeat(32));
    vi.stubEnv("SERVICE_M2M_KEY", "correct-service-key-1234");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the entire provider graph and can start listening", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.close();
  }, 30_000);
});
