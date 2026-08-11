import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Pins public.cod_report_summary (20260729030000_reporting_aggregate_rpcs.sql),
 * the SQL aggregate behind CodService.getReport's summary block.
 *
 * The report used to reduce its totals over the same capped 100-row page its
 * `expectations` list is drawn from, and `discrepancyCount` over the capped
 * discrepancy page, then present both as complete. cod.service.spec.ts asserts
 * the service reads whole totals; this asserts the SQL those totals come from
 * actually computes them, which a hand-written in-memory twin cannot prove.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54721';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Past the report's 100-row list cap, which is what used to bound the totals. */
const OPEN_COUNT = 150;
const EXPECTED_PER_ORDER = 1_000;
const COLLECTED_PER_ORDER = 400;

type SummaryRow = {
  open_count: number;
  discrepancy_count: number;
  expectation_count: number;
  expected_vnd: string;
  collected_vnd: string;
};

describe('cod_report_summary RPC (regression: totals computed over one page)', () => {
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    const [{ data: org, error: orgError }, { data: other, error: otherError }] =
      await Promise.all([
        supabase
          .from('organizations')
          .insert({
            name: 'COD Summary Regression Org',
            slug: `cod-summary-${Date.now()}`,
          })
          .select('id')
          .single(),
        supabase
          .from('organizations')
          .insert({
            name: 'COD Summary Other Org',
            slug: `cod-summary-other-${Date.now()}`,
          })
          .select('id')
          .single(),
      ]);
    if (orgError) throw orgError;
    if (otherError) throw otherError;
    orgId = (org as { id: string }).id;
    otherOrgId = (other as { id: string }).id;

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .insert(
        Array.from({ length: OPEN_COUNT + 3 }, () => ({
          org_id: orgId,
          status: 'shipped',
          payment_method: 'cod',
          total_vnd: EXPECTED_PER_ORDER,
        })),
      )
      .select('id');
    if (ordersError) throw ordersError;
    const orderIds = (orders as Array<{ id: string }>).map((row) => row.id);

    // 150 open expectations, plus one of every status the summary must ignore
    // or classify differently.
    const openOrderIds = orderIds.slice(0, OPEN_COUNT);
    const [discrepancyOrderId, matchedOrderId, writtenOffOrderId] =
      orderIds.slice(OPEN_COUNT);

    const { error: expectationsError } = await supabase
      .from('cod_expectations')
      .insert([
        ...openOrderIds.map((orderId) => ({
          org_id: orgId,
          order_id: orderId,
          expected_vnd: EXPECTED_PER_ORDER,
          status: 'open',
        })),
        {
          org_id: orgId,
          order_id: discrepancyOrderId,
          expected_vnd: EXPECTED_PER_ORDER,
          status: 'discrepancy',
        },
        {
          org_id: orgId,
          order_id: matchedOrderId,
          expected_vnd: 5_000_000,
          status: 'matched',
        },
        {
          org_id: orgId,
          order_id: writtenOffOrderId,
          expected_vnd: 7_000_000,
          status: 'written_off',
        },
      ]);
    if (expectationsError) throw expectationsError;

    const { error: collectionsError } = await supabase
      .from('cod_collections')
      .insert([
        ...openOrderIds.map((orderId) => ({
          org_id: orgId,
          order_id: orderId,
          amount_vnd: COLLECTED_PER_ORDER,
          collected_at: '2026-07-27T10:00:00.000Z',
        })),
        {
          org_id: orgId,
          order_id: discrepancyOrderId,
          amount_vnd: COLLECTED_PER_ORDER,
          collected_at: '2026-07-27T10:00:00.000Z',
        },
        // Belongs to a `matched` expectation, so it is outside the open balance.
        {
          org_id: orgId,
          order_id: matchedOrderId,
          amount_vnd: 5_000_000,
          collected_at: '2026-07-27T10:00:00.000Z',
        },
      ]);
    if (collectionsError) throw collectionsError;

    const { error: discrepanciesError } = await supabase
      .from('cod_discrepancies')
      .insert([
        {
          org_id: orgId,
          order_id: discrepancyOrderId,
          expected_vnd: EXPECTED_PER_ORDER,
          collected_vnd: COLLECTED_PER_ORDER,
          delta_vnd: COLLECTED_PER_ORDER - EXPECTED_PER_ORDER,
          status: 'open',
        },
      ]);
    if (discrepanciesError) throw discrepanciesError;
  }, 60_000);

  it('aggregates over every open/discrepant expectation, not the first 100', async () => {
    const { data, error } = await supabase.rpc('cod_report_summary', {
      p_org_id: orgId,
    });

    expect(error).toBeNull();
    const row = (data as SummaryRow[])[0];

    expect(row.open_count).toBe(OPEN_COUNT);
    expect(row.discrepancy_count).toBe(1);
    expect(row.expectation_count).toBe(OPEN_COUNT + 1);
    // `matched` (5,000,000) and `written_off` (7,000,000) stay out of the open
    // balance; the discrepant one stays in.
    expect(row.expected_vnd).toBe(
      String((OPEN_COUNT + 1) * EXPECTED_PER_ORDER),
    );
    expect(row.collected_vnd).toBe(
      String((OPEN_COUNT + 1) * COLLECTED_PER_ORDER),
    );
  });

  it('is org-scoped', async () => {
    const { data, error } = await supabase.rpc('cod_report_summary', {
      p_org_id: otherOrgId,
    });

    expect(error).toBeNull();
    expect((data as SummaryRow[])[0]).toMatchObject({
      open_count: 0,
      discrepancy_count: 0,
      expectation_count: 0,
      expected_vnd: '0',
      collected_vnd: '0',
    });
  });
});
