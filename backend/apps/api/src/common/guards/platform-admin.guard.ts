import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AuthenticatedUser } from "../decorators/current-user.decorator";
import { loadEnv } from "../../config/env";

export const PLATFORM_ADMINS_REPOSITORY = Symbol(
  "PLATFORM_ADMINS_REPOSITORY",
);

export interface PlatformAdminsRepository {
  isPlatformAdmin(userId: string): Promise<boolean>;
}

type PlatformAdminRow = {
  user_id: string;
};

type RequestWithUser = {
  user?: AuthenticatedUser;
};

@Injectable()
export class SupabasePlatformAdminsRepository
  implements PlatformAdminsRepository
{
  private readonly supabase: SupabaseClient;

  constructor(@Optional() supabase?: SupabaseClient) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async isPlatformAdmin(userId: string) {
    const { data, error } = await this.supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return Boolean(data as PlatformAdminRow | null);
  }
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(PLATFORM_ADMINS_REPOSITORY)
    private readonly platformAdmins: PlatformAdminsRepository,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException({
        code: "user_required",
        message: "Authenticated user is required",
      });
    }

    if (!(await this.platformAdmins.isPlatformAdmin(userId))) {
      throw new ForbiddenException({
        code: "platform_admin_required",
        message: "Platform admin access is required",
      });
    }

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
