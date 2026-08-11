import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

type NextFunction = () => void;

export type RequestWithIdempotencyKey = IncomingMessage & {
  idempotencyKey?: string;
};

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function idempotencyMiddleware(
  req: RequestWithIdempotencyKey,
  _res: ServerResponse,
  next: NextFunction,
) {
  if (req.method?.toUpperCase() === "POST") {
    const idempotencyKey = getHeader(req.headers, "idempotency-key")?.trim();
    if (idempotencyKey) {
      req.idempotencyKey = idempotencyKey;
    }
  }

  next();
}
