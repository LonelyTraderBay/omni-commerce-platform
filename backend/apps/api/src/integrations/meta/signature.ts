import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const actual = signatureHeader.slice("sha256=".length);
  try {
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
  } catch {
    return false;
  }
}
