import { describe, expect, it } from "vitest";

import { GraphClient } from "./graph.client";

const client = new GraphClient({
  appId: "local-app",
  appSecret: "local-secret",
  redirectUri: "http://127.0.0.1:4700/settings/channels/callback",
  graphVersion: "v21.0",
  mode: "stub",
});

describe("GraphClient local stub", () => {
  it("completes the local OAuth discovery path without network calls", async () => {
    const token = await client.exchangeCodeForToken("local-meta-code");
    const debug = await client.debugToken(token.access_token);
    const pages = await client.getManagedPages(token.access_token);
    const pageToken = await client.getPageAccessToken(
      pages.data[0].id,
      token.access_token,
    );

    expect(debug.data.is_valid).toBe(true);
    expect(pages.data[0].id).toBe("local-meta-page");
    expect(pageToken.access_token).toContain("local-page-token-");
  });

  it("returns deterministic local message ids", async () => {
    await expect(
      client.sendMessage({
        accessToken: "local-page-token",
        recipientId: "local-customer",
        senderId: "local-meta-page",
        text: "Xin chao",
      }),
    ).resolves.toEqual({
      message_id: "local-meta-message-local-customer-local-meta-page",
      recipient_id: "local-customer",
    });
  });
});
