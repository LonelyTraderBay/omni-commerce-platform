import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { loadEnv } from "../../config/env";

type RequestWithServiceKey = {
  headers: IncomingHttpHeaders;
};

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const direct = headers[name.toLowerCase()];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct[0] : direct;
  }

  const header = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(header) ? header[0] : header;
}

function serviceKeysMatch(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

@Injectable()
export class ServiceKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithServiceKey>();
    const expectedKey = loadEnv().SERVICE_M2M_KEY;
    const actualKey = getHeader(request.headers, "x-service-key")?.trim();

    if (!actualKey || !serviceKeysMatch(actualKey, expectedKey)) {
      throw new UnauthorizedException({
        code: "invalid_service_key",
        message: "X-Service-Key is invalid",
      });
    }

    return true;
  }
}
