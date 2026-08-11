import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../../config/env";

export const FEATURE_FLAGS_SUPABASE = Symbol("FEATURE_FLAGS_SUPABASE");

const FEATURE_FLAG_SELECT = "key, org_id, enabled";

export type SupabaseLike = Pick<SupabaseClient, "from">;

type SupabaseError = {
  code?: string;
  message?: string;
};

type FeatureFlagRow = {
  key: string;
  org_id: string | null;
  enabled: boolean;
};

@Injectable()
export class FeatureFlagsService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(FEATURE_FLAGS_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async isEnabled(key: string, orgId: string | null) {
    if (orgId) {
      const orgFlag = await this.supabase
        .from("feature_flags")
        .select(FEATURE_FLAG_SELECT)
        .eq("key", key)
        .eq("org_id", orgId)
        .maybeSingle();

      if (orgFlag.error) {
        throwFeatureFlagsError(orgFlag.error, "Could not read feature flag");
      }
      if (orgFlag.data) {
        return Boolean((orgFlag.data as FeatureFlagRow).enabled);
      }
    }

    const globalFlag = await this.supabase
      .from("feature_flags")
      .select(FEATURE_FLAG_SELECT)
      .eq("key", key)
      .is("org_id", null)
      .maybeSingle();

    if (globalFlag.error) {
      throwFeatureFlagsError(globalFlag.error, "Could not read feature flag");
    }

    return Boolean((globalFlag.data as FeatureFlagRow | null)?.enabled ?? false);
  }
}

function throwFeatureFlagsError(
  error: SupabaseError,
  message: string,
): never {
  throw new InternalServerErrorException({
    code: "feature_flags_read_failed",
    message,
  });
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
