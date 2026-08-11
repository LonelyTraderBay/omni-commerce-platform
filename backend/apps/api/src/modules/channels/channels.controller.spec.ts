import { ParseUUIDPipe } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ChannelsController } from "./channels.controller";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONNECTION_ID = "33333333-3333-3333-3333-333333333333";

describe("ChannelsController", () => {
  it("revokeChannel delegates a standard UUID to the service", async () => {
    const revokeConnection = vi.fn().mockResolvedValue({
      connection: { status: "revoked" },
    });
    const controller = new ChannelsController({
      revokeConnection,
    } as never);

    await controller.revokeChannel(ORG_ID, CONNECTION_ID);

    expect(revokeConnection).toHaveBeenCalledWith(ORG_ID, CONNECTION_ID);
  });

  it("ParseUUIDPipe accepts a standard UUID", async () => {
    const pipe = new ParseUUIDPipe();
    await expect(
      pipe.transform(CONNECTION_ID, {
        type: "param",
        metatype: String,
        data: "id",
      }),
    ).resolves.toBe(CONNECTION_ID);
  });
});
