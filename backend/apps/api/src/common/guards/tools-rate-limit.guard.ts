import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

import {
  defaultRateLimiter,
  InMemoryRateLimiter,
} from "../rate-limit/in-memory-rate-limit";
import { loadRateLimitConfig } from "../rate-limit/rate-limit-config";
import { buildToolsRateLimitKey } from "../rate-limit/rate-limit-keys";
import {
  extractOrgIdFromBody,
  getRequestPath,
  isToolsPath,
} from "../rate-limit/rate-limit-paths";

type RequestWithBody = {
  body?: unknown;
  originalUrl?: string;
  url?: string;
};

@Injectable()
export class ToolsRateLimitGuard implements CanActivate {
  private readonly limiter: InMemoryRateLimiter;

  constructor(@Optional() limiter?: InMemoryRateLimiter) {
    this.limiter = limiter ?? defaultRateLimiter;
  }

  canActivate(context: ExecutionContext) {
    const config = loadRateLimitConfig();
    if (!config.enabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithBody>();
    const path = getRequestPath(request.originalUrl, request.url);
    if (!isToolsPath(path)) {
      return true;
    }

    const orgId = extractOrgIdFromBody(request.body);
    if (!orgId) {
      return true;
    }

    const result = this.limiter.consume(
      buildToolsRateLimitKey(orgId, path),
      config.tools.max,
      config.tools.windowMs,
    );
    if (!result.allowed) {
      throw new HttpException(
        {
          code: "rate_limit_exceeded",
          message: "Too many internal tool requests for this organization",
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}