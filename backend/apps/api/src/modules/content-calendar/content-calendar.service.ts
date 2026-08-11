import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv } from '../../config/env';
import { AuditService, type WriteAuditInput } from '../audit/audit.service';
import type {
  ContentCalendarStatus,
  CreateContentCalendarItemBody,
  ListContentCalendarQuery,
  UpdateContentCalendarItemBody,
} from './dto';

export const CONTENT_CALENDAR_SUPABASE = Symbol('CONTENT_CALENDAR_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;
export type AuditWriter = {
  writeAudit(input: WriteAuditInput): Promise<unknown>;
};

type ContentCalendarItemRow = {
  id: string;
  org_id: string;
  title: string;
  body: string | null;
  planned_at: string;
  status: ContentCalendarStatus;
  channel_hint: string | null;
  auto_post_enabled: boolean;
  created_at: string;
  updated_at: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

const CONTENT_CALENDAR_SELECT =
  'id, org_id, title, body, planned_at, status, channel_hint, auto_post_enabled, created_at, updated_at';

@Injectable()
export class ContentCalendarService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(CONTENT_CALENDAR_SUPABASE)
    supabase: SupabaseLike | undefined,
    @Inject(AuditService)
    private readonly audit: AuditWriter,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async listItems(orgId: string, query: ListContentCalendarQuery) {
    let builder = this.supabase
      .from('content_calendar_items')
      .select(CONTENT_CALENDAR_SELECT)
      .eq('org_id', orgId)
      .order('planned_at', { ascending: true })
      .limit(200);

    if (query.status) {
      builder = builder.eq('status', query.status);
    }

    const { data, error } = await builder;
    if (error) {
      throwContentCalendarError(error, 'Could not list calendar items');
    }

    return { items: ((data ?? []) as ContentCalendarItemRow[]).map(mapItem) };
  }

  async createItem(input: {
    orgId: string;
    actorUserId: string;
    body: CreateContentCalendarItemBody;
  }) {
    const { data, error } = await this.supabase
      .from('content_calendar_items')
      .insert({
        org_id: input.orgId,
        title: input.body.title,
        body: input.body.body ?? null,
        planned_at: input.body.plannedAt,
        status: input.body.status,
        channel_hint: input.body.channelHint ?? null,
        auto_post_enabled: input.body.autoPostEnabled,
      })
      .select(CONTENT_CALENDAR_SELECT)
      .single();

    if (error) {
      throwContentCalendarError(error, 'Could not create calendar item');
    }

    const item = mapItem(data as ContentCalendarItemRow);
    await this.writeAudit({
      action: 'content_calendar.created',
      actorUserId: input.actorUserId,
      entityId: item.id,
      item,
      orgId: input.orgId,
    });
    return { item };
  }

  async updateItem(input: {
    orgId: string;
    itemId: string;
    actorUserId: string;
    body: UpdateContentCalendarItemBody;
  }) {
    const patch = toUpdatePatch(input.body);
    const { data, error } = await this.supabase
      .from('content_calendar_items')
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.itemId)
      .eq('org_id', input.orgId)
      .select(CONTENT_CALENDAR_SELECT)
      .maybeSingle();

    if (error) {
      throwContentCalendarError(error, 'Could not update calendar item');
    }
    if (!data) {
      throwNotFound();
    }

    const item = mapItem(data as ContentCalendarItemRow);
    await this.writeAudit({
      action: 'content_calendar.updated',
      actorUserId: input.actorUserId,
      entityId: item.id,
      item,
      orgId: input.orgId,
    });
    return { item };
  }

  async deleteItem(input: {
    orgId: string;
    itemId: string;
    actorUserId: string;
  }) {
    const { data, error } = await this.supabase
      .from('content_calendar_items')
      .delete()
      .eq('id', input.itemId)
      .eq('org_id', input.orgId)
      .select(CONTENT_CALENDAR_SELECT)
      .maybeSingle();

    if (error) {
      throwContentCalendarError(error, 'Could not delete calendar item');
    }
    if (!data) {
      throwNotFound();
    }

    const item = mapItem(data as ContentCalendarItemRow);
    await this.writeAudit({
      action: 'content_calendar.deleted',
      actorUserId: input.actorUserId,
      entityId: item.id,
      item,
      orgId: input.orgId,
    });
    return { item };
  }

  private async writeAudit(input: {
    action: string;
    actorUserId: string;
    entityId: string;
    item: ReturnType<typeof mapItem>;
    orgId: string;
  }) {
    await this.audit.writeAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorType: 'user',
      action: input.action,
      entityType: 'content_calendar_item',
      entityId: input.entityId,
      meta: {
        status: input.item.status,
        plannedAt: input.item.plannedAt,
        autoPostEnabled: input.item.autoPostEnabled,
        autoPostNote:
          input.item.autoPostEnabled === true
            ? 'Stored only. Meta auto-post is intentionally not implemented in Plan G.'
            : 'Auto-post disabled by default.',
      },
    });
  }
}

function toUpdatePatch(body: UpdateContentCalendarItemBody) {
  return {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.body !== undefined ? { body: body.body ?? null } : {}),
    ...(body.plannedAt !== undefined ? { planned_at: body.plannedAt } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.channelHint !== undefined
      ? { channel_hint: body.channelHint ?? null }
      : {}),
    ...(body.autoPostEnabled !== undefined
      ? { auto_post_enabled: body.autoPostEnabled }
      : {}),
  };
}

function mapItem(row: ContentCalendarItemRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    body: row.body,
    plannedAt: row.planned_at,
    status: row.status,
    channelHint: row.channel_hint,
    autoPostEnabled: row.auto_post_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function throwNotFound(): never {
  throw new NotFoundException({
    code: 'content_calendar_item_not_found',
    message: 'Content calendar item was not found',
  });
}

function throwContentCalendarError(error: SupabaseError, message: string): never {
  throw new InternalServerErrorException({
    code: 'content_calendar_failed',
    message: error.message ?? message,
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
