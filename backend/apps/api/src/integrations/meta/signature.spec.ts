import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "./signature";

describe("verifyMetaSignature", () => {
  const secret = "meta-app-secret";
  const body = Buffer.from('{"object":"page"}', "utf8");
  const sig =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts valid signature", () => {
    expect(verifyMetaSignature(body, sig, secret)).toBe(true);
  });

  it("rejects missing or bad signature", () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects wrong prefix", () => {
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyMetaSignature(body, `sha1=${hex}`, secret)).toBe(false);
    expect(verifyMetaSignature(body, hex, secret)).toBe(false);
  });

  it("rejects wrong secret", () => {
    expect(verifyMetaSignature(body, sig, "other-secret")).toBe(false);
  });

  it("rejects length mismatch without throwing", () => {
    expect(verifyMetaSignature(body, "sha256=abc", secret)).toBe(false);
  });

  it("rejects tampered body", () => {
    const tampered = Buffer.from('{"object":"user"}', "utf8");
    expect(verifyMetaSignature(tampered, sig, secret)).toBe(false);
  });
});
