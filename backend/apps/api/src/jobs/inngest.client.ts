import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "omni-platform",
  eventKey: process.env.INNGEST_EVENT_KEY || undefined,
  signingKey: process.env.INNGEST_SIGNING_KEY || undefined,
  isDev: process.env.NODE_ENV !== "production",
});
