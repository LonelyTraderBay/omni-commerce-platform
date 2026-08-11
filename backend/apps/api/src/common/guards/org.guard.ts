import {
  BadRequestException,
  ForbiddenException,
  Inject,
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

export const MEMBERSHIPS_REPOSITORY = Symbol("MEMBERSHIPS_REPOSITORY");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MembershipRole = "owner" | "cskh" | "kho";

export type Membership = {
  id: string;
  orgId: string;
  userId: string;
  role: MembershipRole;
};

export type MembershipLookup = {
  orgId: string;
  userId: string;
};

export interface MembershipsRepository {
  findMembership(input: MembershipLookup): Promise<Membership | null>;
}

type MembershipRow = {
  id: string;
  org_id: string;
  user_id: string;
  role: MembershipRole;
};

type RequestWithOrg = {
  headers: IncomingHttpHeaders;
  membership?: Membership;
  method?: string;
  orgId?: string;
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

function getPath(request: Pick<RequestWithOrg, "originalUrl" | "url">) {
  return (request.originalUrl ?? request.url ?? "").split("?")[0];
}

function isSkippedPath(path: string, method = "GET") {
  if (
    path === "/v1/orgs" &&
    (method.toUpperCase() === "POST" || method.toUpperCase() === "GET")
  ) {
    return true;
  }

  return (
    path === "/health" ||
    path === "/ready" ||
    path === "/v1/auth/sso/status" ||
    path === "/api/inngest" ||
    path === "/v1/webhooks/meta" ||
    path === "/v1/channels/zalo/webhook" ||
    path === "/v1/invites/accept" ||
    path === "/ops" ||
    path.startsWith("/ops/") ||
    path.startsWith("/public/v1/") ||
    path === "/internal" ||
    path.startsWith("/internal/")
  );
}

function getRequiredOrgId(headers: IncomingHttpHeaders) {
  const orgId = getHeader(headers, "x-org-id")?.trim();
  if (!orgId) {
    throw new BadRequestException({
      code: "missing_org_id",
      message: "X-Org-Id header is required",
    });
  }

  if (!UUID_PATTERN.test(orgId)) {
    throw new BadRequestException({
      code: "invalid_org_id",
      message: "X-Org-Id header must be a UUID",
    });
  }

  return orgId;
}

@Injectable()
export class SupabaseMembershipsRepository implements MembershipsRepository {
  private readonly supabase: SupabaseClient;

  constructor(@Optional() supabase?: SupabaseClient) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async findMembership({ orgId, userId }: MembershipLookup) {
    const { data, error } = await this.supabase
      .from("memberships")
      .select("id, org_id, user_id, role")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const row = data as MembershipRow | null;
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      role: row.role,
    };
  }
}

@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    @Inject(MEMBERSHIPS_REPOSITORY)
    private readonly memberships: MembershipsRepository,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithOrg>();
    if (isSkippedPath(getPath(request), request.method)) {
      return true;
    }

    const orgId = getRequiredOrgId(request.headers);
    if (!request.user?.id) {
      throw new UnauthorizedException({
        code: "user_required",
        message: "Authenticated user is required",
      });
    }

    const membership = await this.memberships.findMembership({
      orgId,
      userId: request.user.id,
    });
    if (!membership) {
      throw new ForbiddenException({
        code: "org_membership_required",
        message: "User is not a member of this organization",
      });
    }

    request.orgId = orgId;
    request.membership = membership;
    return true;
  }
}

function createSupabaseServiceClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
