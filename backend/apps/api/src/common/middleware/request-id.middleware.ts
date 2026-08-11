import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

type NextFunction = () => void;

export type RequestWithRequestId = IncomingMessage & {
  requestId?: string;
};

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function requestIdMiddleware(
  req: RequestWithRequestId,
  res: ServerResponse,
  next: NextFunction,
) {
  const incomingRequestId = getHeader(req.headers, "x-request-id")?.trim();
  const requestId = incomingRequestId || randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}
