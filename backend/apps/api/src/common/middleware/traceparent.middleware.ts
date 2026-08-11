import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

type NextFunction = () => void;

export type RequestWithTraceparent = IncomingMessage & {
  traceparent?: string;
};

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function generateTraceparent() {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

export function traceparentMiddleware(
  req: RequestWithTraceparent,
  res: ServerResponse,
  next: NextFunction,
) {
  const incomingTraceparent = getHeader(req.headers, "traceparent")?.trim();
  const traceparent = incomingTraceparent || generateTraceparent();

  req.traceparent = traceparent;
  req.headers.traceparent = traceparent;
  res.setHeader("traceparent", traceparent);
  next();
}
