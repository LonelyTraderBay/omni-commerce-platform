import { describe, expect, it } from "vitest";
import { encryptToken, decryptToken } from "./token-crypto";

describe("token-crypto", () => {
  const key = "dev-token-encryption-key-32chars!!";

  it("roundtrips and does not leak plaintext", () => {
    const enc = encryptToken("EAAB_test_token", key);
    expect(enc).not.toContain("EAAB");
    expect(decryptToken(enc, key)).toBe("EAAB_test_token");
  });

  it("throws on tamper", () => {
    const enc = encryptToken("x", key);
    const bad = Buffer.from(enc, "base64url");
    bad[bad.length - 1] ^= 0xff;
    expect(() => decryptToken(Buffer.from(bad).toString("base64url"), key)).toThrow();
  });
});
