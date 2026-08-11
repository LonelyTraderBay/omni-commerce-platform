import { inngest } from "../inngest.client";

type PlatformNoopEvent = {
  data: {
    orgId: string;
  };
};

export const platformNoop = inngest.createFunction(
  { id: "platform-noop", triggers: { event: "platform/noop" } },
  async ({ event }) => {
    const noopEvent = event as unknown as PlatformNoopEvent;

    return {
      ok: true,
      orgId: noopEvent.data.orgId,
    };
  },
);
