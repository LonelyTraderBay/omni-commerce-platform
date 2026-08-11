import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../../config/env";

export const AUDIT_SUPABASE = Symbol("AUDIT_SUPABASE");

const AUDIT_SELECT =
  "id, org_id, actor_user_id, actor_type, action, entity_type, entity_id, meta_json, created_at";

export type AuditActorType = "user" | "system" | "ai" | "platform";
export type SupabaseLike = Pick<SupabaseClient, "from">;

export type WriteAuditInput = {
  action: string;
  entityType: string;
  entityId: string | null;
  meta: Record<string, unknown>;
  orgId?: string | null;
  actorUserId?: string | null;
  actorType?: AuditActorType;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type AuditLogRow = {
  id: string;
  org_id: string | null;
  actor_user_id: string | null;
  actor_type: AuditActorType;
  action: string;
  entity_type: string;
  entity_id: string | null;
  meta_json: Record<string, unknown>;
  created_at: string;
};

@Injectable()
export class AuditService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(AUDIT_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async writeAudit(input: WriteAuditInput) {
    const { data, error } = await this.supabase
      .from("audit_logs")
      .insert({
        org_id: input.orgId ?? null,
        actor_user_id: input.actorUserId ?? null,
        actor_type: input.actorType ?? "platform",
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId,
        meta_json: input.meta,
      })
      .select(AUDIT_SELECT)
      .single();

    if (error) {
      throwAuditError(error, "Could not write audit log");
    }

    return { audit: mapAuditLog(data as AuditLogRow) };
  }
}

function mapAuditLog(row: AuditLogRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    actorUserId: row.actor_user_id,
    actorType: row.actor_type,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    meta: row.meta_json,
    createdAt: row.created_at,
  };
}

function throwAuditError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: "audit_write_failed",
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
