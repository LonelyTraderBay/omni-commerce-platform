import {
  Injectable,
  Optional,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { IncomingHttpHeaders } from "node:http";

import type { AuthenticatedUser } from "../decorators/current-user.decorator";
import { loadEnv } from "../../config/env";

type RequestWithAuth = {
  headers: IncomingHttpHeaders;
  originalUrl?: string;
  url?: string;
  user?: AuthenticatedUser;
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

function getPath(request: Pick<RequestWithAuth, "originalUrl" | "url">) {
  return (request.originalUrl ?? request.url ?? "").split("?")[0];
}

function isPublicPath(path: string) {
  return (
    path === "/health" ||
    path === "/ready" ||
    path === "/v1/auth/sso/status" ||
    path === "/api/inngest" ||
    path === "/v1/webhooks/meta" ||
    path === "/v1/channels/zalo/webhook" ||
    path.startsWith("/public/v1/") ||
    path === "/internal" ||
    path.startsWith("/internal/")
  );
}

function getBearerToken(headers: IncomingHttpHeaders) {
  const authorization = getHeader(headers, "authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly supabase: SupabaseClient;

  constructor(@Optional() supabase?: SupabaseClient) {
    this.supabase = supabase ?? createSupabaseAuthClient();
  }

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    if (isPublicPath(getPath(request))) {
      return true;
    }

    const jwt = getBearerToken(request.headers);
    if (!jwt) {
      throw new UnauthorizedException({
        code: "bearer_required",
        message: "Bearer token is required",
      });
    }

    const { data, error } = await this.supabase.auth.getUser(jwt);
    if (error || !data.user) {
      throw new UnauthorizedException({
        code: "invalid_bearer",
        message: "Bearer token is invalid",
      });
    }

    request.user = {
      id: data.user.id,
      email: data.user.email ?? undefined,
    };

    return true;
  }
}

function createSupabaseAuthClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
