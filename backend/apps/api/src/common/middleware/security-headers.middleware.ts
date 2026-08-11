import type { IncomingMessage, ServerResponse } from "node:http";

type NextFunction = () => void;

export function securityHeadersMiddleware(
  _req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}
