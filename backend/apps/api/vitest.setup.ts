import { beforeEach, vi } from "vitest";

function stubMetaEnv(): void {
  vi.stubEnv("META_APP_ID", "1234567890");
  vi.stubEnv("META_APP_SECRET", "meta-app-secret-for-tests");
  vi.stubEnv("META_VERIFY_TOKEN", "test-verify-token");
  vi.stubEnv("META_REDIRECT_URI", "https://example.test/oauth/meta/callback");
}

beforeEach(() => {
  stubMetaEnv();
});
