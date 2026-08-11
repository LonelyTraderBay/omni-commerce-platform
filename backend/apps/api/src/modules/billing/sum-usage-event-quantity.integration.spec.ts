import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

import { AI_TOKEN_USAGE_KIND } from './ai-token-usage.service';

/**
 * Pins public.sum_usage_event_quantity (20260729030000_reporting_aggregate_rpcs.sql),
 * the SQL aggregate behind BillingService.sumAiTokens and
 * AiTokenUsageService.loadMonthlyUsage.
 *
 * Both used to fetch `usage_events` rows and sum them in Node with no `.limit()`.
 * That is not a slow-path concern, it is a wrong-number concern: PostgREST caps
 * every response at `db-max-rows` (1000 by default), so past 1000 events in a
 * month the billing screen under-reported AI usage and — worse — the quota gate
 * built on the same read under-counted, so the limit never engaged for exactly
 * the orgs busy enough to hit it.
 *
 * A mocked Supabase client cannot see this: the cap lives in PostgREST, not in
 * the service. Following the receive-po.integration.spec.ts precedent, this runs
 * against the local Supabase (`pnpm run dev:local`) and seeds past the cap, then
 * asserts the truncation is observable through a plain select and absent from
 * the RPC.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54721';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Comfortably past PostgREST's default `db-max-rows` of 1000. */
const EVENT_COUNT = 1_500;
const QUANTITY_PER_EVENT = 1_000;
const PERIOD_START = '2026-07-01T00:00:00.000Z';

describe('sum_usage_event_quantity RPC (regression: client-side sum truncated at db-max-rows)', () => {
  let orgId: string;

  beforeAll(async () => {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: 'AI Token Sum Regression Org',
        slug: `ai-token-sum-${Date.now()}`,
      })
      .select('id')
      .single();
    if (orgError) throw orgError;
    orgId = (org as { id: string }).id;

    const events = Array.from({ length: EVENT_COUNT }, (_, index) => ({
      org_id: orgId,
      kind: AI_TOKEN_USAGE_KIND,
      quantity: QUANTITY_PER_EVENT,
      created_at: new Date(
        Date.UTC(2026, 6, 2, 0, 0, 0) + index * 1_000,
      ).toISOString(),
    }));
    const { error: eventsError } = await supabase
      .from('usage_events')
      .insert(events);
    if (eventsError) throw eventsError;

    // Noise the aggregate must exclude: a different kind, and an event from the
    // previous billing period.
    const { error: noiseError } = await supabase.from('usage_events').insert([
      {
        org_id: orgId,
        kind: 'other_meter',
        quantity: 999_999,
        created_at: '2026-07-15T00:00:00.000Z',
      },
      {
        org_id: orgId,
        kind: AI_TOKEN_USAGE_KIND,
        quantity: 888_888,
        created_at: '2026-06-30T23:59:59.000Z',
      },
    ]);
    if (noiseError) throw noiseError;
  }, 60_000);

  it('sums every event in the period, past the row cap the old client-side sum hit', async () => {
    const { data, error } = await supabase.rpc('sum_usage_event_quantity', {
      p_org_id: orgId,
      p_kind: AI_TOKEN_USAGE_KIND,
      p_since: PERIOD_START,
    });

    expect(error).toBeNull();
    // Returned as text so a bigint sum survives the JSON round-trip intact.
    expect(data).toBe(String(EVENT_COUNT * QUANTITY_PER_EVENT));
  });

  it('proves the old read really was truncated, so this is a fix and not a refactor', async () => {
    const { data, error } = await supabase
      .from('usage_events')
      .select('quantity')
      .eq('org_id', orgId)
      .eq('kind', AI_TOKEN_USAGE_KIND)
      .gte('created_at', PERIOD_START);

    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ quantity: number }>;
    // The shape the services used to run: fewer rows come back than exist, with
    // no error and nothing marking the response as partial.
    expect(rows.length).toBeLessThan(EVENT_COUNT);
    const clientSideSum = rows.reduce((total, row) => total + row.quantity, 0);
    expect(clientSideSum).toBeLessThan(EVENT_COUNT * QUANTITY_PER_EVENT);
  });

  it('excludes other meters and earlier periods', async () => {
    const { data, error } = await supabase.rpc('sum_usage_event_quantity', {
      p_org_id: orgId,
      p_kind: 'other_meter',
      p_since: PERIOD_START,
    });

    expect(error).toBeNull();
    expect(data).toBe('999999');
  });

  it('returns 0 rather than null for an org with no usage', async () => {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: 'AI Token Sum Empty Org',
        slug: `ai-token-sum-empty-${Date.now()}`,
      })
      .select('id')
      .single();
    if (orgError) throw orgError;

    const { data, error } = await supabase.rpc('sum_usage_event_quantity', {
      p_org_id: (org as { id: string }).id,
      p_kind: AI_TOKEN_USAGE_KIND,
      p_since: PERIOD_START,
    });

    expect(error).toBeNull();
    expect(data).toBe('0');
  });
});
