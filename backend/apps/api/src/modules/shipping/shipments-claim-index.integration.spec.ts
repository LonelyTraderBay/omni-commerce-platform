import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Direct-to-Postgres proof for `shipments_one_live_claim_per_order_idx` and
 * the status-check widening, both added by
 * 20260729050000_shipments_claim_then_call.sql -- the partial unique index
 * `ShippingService.claimShipment` (shipping.service.ts) relies on to make the
 * claim-then-call fix race-proof against *truly* concurrent requests.
 *
 * `shipping.service.spec.ts`'s `stubShipmentsTable` proves the SERVICE logic
 * makes the right decisions (insert, reclaim, or conflict) given a certain
 * table state, but it is a hand-rolled JS fake: it cannot prove that the
 * REAL partial unique index enforces the invariant it is supposed to, and it
 * cannot prove anything about Postgres's own concurrency control (row
 * locking / EvalPlanQual), which is exactly the mechanism
 * `reclaimStaleShipmentClaim`'s conditional UPDATE depends on. Only a real
 * Postgres can demonstrate either of those. Every probe here talks to
 * `shipments` directly via the Supabase client (bypassing ShippingService
 * entirely), following the apply-order-stock-change.integration.spec.ts /
 * create-and-confirm-order-outbox.integration.spec.ts precedent: a disposable
 * org (and order) per test, cleaned up in `afterAll`, against the local
 * Supabase Postgres (`pnpm run dev:local`).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54721';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Mirrors CLAIM_TTL_MS in shipping.service.ts. */
const CLAIM_TTL_MS = 2 * 60 * 1000;

type ShipmentInsert = {
  org_id: string;
  order_id: string;
  status: string;
  raw_json?: Record<string, unknown>;
  created_at?: string;
};

async function createOrg(slugPrefix: string) {
  const { data, error } = await supabase
    .from('organizations')
    .insert({
      name: 'Shipments Claim Index Regression Org',
      slug: `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function createOrder(orgId: string) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      org_id: orgId,
      status: 'confirmed',
      payment_method: 'cod',
      subtotal_vnd: 40000,
      total_vnd: 40000,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

function insertShipment(row: ShipmentInsert) {
  return supabase
    .from('shipments')
    .insert({
      provider: 'ghn',
      fee_vnd: 0,
      raw_json: {},
      ...row,
    })
    .select('id, status, raw_json')
    .single();
}

describe('shipments_one_live_claim_per_order_idx (real Postgres)', () => {
  let orgId: string;

  beforeAll(async () => {
    orgId = await createOrg('shipments-claim-index');
  });

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  it('accepts `pending` as a valid status under the widened shipments_status_check', async () => {
    const orderId = await createOrder(orgId);
    const { error } = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(error).toBeNull();
  });

  it('rejects a second `pending` claim for the same order', async () => {
    const orderId = await createOrder(orgId);

    const first = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(first.error).toBeNull();

    const second = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.code).toBe('23505');
    expect(second.error?.message ?? '').toContain(
      'shipments_one_live_claim_per_order_idx',
    );
  });

  it('rejects a `pending` claim when a `created` (booked) shipment already exists', async () => {
    const orderId = await createOrder(orgId);

    const booked = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'created',
    });
    expect(booked.error).toBeNull();

    const claim = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(claim.error).not.toBeNull();
    expect(claim.error?.code).toBe('23505');
  });

  it('allows a new `pending` claim after the prior attempt is `failed`', async () => {
    const orderId = await createOrder(orgId);

    const failed = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'failed',
    });
    expect(failed.error).toBeNull();

    const retry = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(retry.error).toBeNull();
  });

  it('allows a new `pending` claim after the prior attempt is `cancelled`', async () => {
    const orderId = await createOrder(orgId);

    const cancelled = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'cancelled',
    });
    expect(cancelled.error).toBeNull();

    const retry = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(retry.error).toBeNull();
  });

  it('allows a new `pending` claim alongside an existing mock-tagged row', async () => {
    const orderId = await createOrder(orgId);

    const mock = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'created',
      raw_json: { mode: 'mock' },
    });
    expect(mock.error).toBeNull();

    const claim = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(claim.error).toBeNull();
  });

  it('allows a second mock-tagged row for the same order (existing mock behaviour preserved)', async () => {
    const orderId = await createOrder(orgId);

    const firstMock = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'created',
      raw_json: { mode: 'mock' },
    });
    expect(firstMock.error).toBeNull();

    const secondMock = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'created',
      raw_json: { mode: 'mock' },
    });
    expect(secondMock.error).toBeNull();
  });

  it('drops a claim out of the index the moment it is finalized as a mock result, unblocking a fresh claim', async () => {
    // The subtlest part of the design: a claim row starts life participating
    // in the index (raw_json = '{}', mode absent) and must correctly OPT OUT
    // the instant the very same UPDATE that finalizes it as a mock result
    // writes raw_json.mode = 'mock' -- proving the transition, not just the
    // two static end-states.
    const orderId = await createOrder(orgId);

    const { data: claim, error: claimError } = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(claimError).toBeNull();
    const claimId = (claim as { id: string }).id;

    // While pending, a second claim for the same order is correctly blocked.
    const blockedWhilePending = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(blockedWhilePending.error?.code).toBe('23505');

    // Finalize the original claim AS a mock result (mirrors
    // finalizeShipmentClaim's UPDATE for an isMock provider result).
    const { error: finalizeError } = await supabase
      .from('shipments')
      .update({
        status: 'created',
        tracking_code: 'GHN-MOCK-INDEX-TRANSITION',
        raw_json: { mode: 'mock' },
      })
      .eq('id', claimId);
    expect(finalizeError).toBeNull();

    // Now a fresh claim for the SAME order succeeds: the finalized mock row
    // no longer occupies the index's slot.
    const afterFinalize = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    expect(afterFinalize.error).toBeNull();
  });

  it('two concurrent reclaim attempts on the same stale pending claim: exactly one wins', async () => {
    // This is the property that makes reclaimStaleShipmentClaim
    // (shipping.service.ts) safe: the conditional UPDATE's WHERE clause
    // compares `updated_at`, the SAME column its SET clause refreshes to
    // "now". A mocked Supabase client cannot prove this -- there is no real
    // concurrent transaction / row-lock machinery to race against -- only
    // Postgres's own MVCC (row locking + EvalPlanQual re-evaluating the
    // WHERE clause against the winner's committed row) can demonstrate it.
    const orderId = await createOrder(orgId);
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: claim, error: claimError } = await insertShipment({
      org_id: orgId,
      order_id: orderId,
      status: 'pending',
    });
    if (claimError) throw claimError;
    const claimId = (claim as { id: string }).id;

    // Backdate `updated_at` directly (bypassing application code) to model a
    // claim abandoned well past CLAIM_TTL_MS.
    const { error: backdateError } = await supabase
      .from('shipments')
      .update({ updated_at: staleIso })
      .eq('id', claimId);
    if (backdateError) throw backdateError;

    const cutoffIso = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
    const attemptReclaim = (tag: string) =>
      supabase
        .from('shipments')
        .update({
          status: 'pending',
          raw_json: { reclaimedBy: tag },
          updated_at: new Date().toISOString(),
        })
        .eq('id', claimId)
        .eq('status', 'pending')
        .lt('updated_at', cutoffIso)
        .select('id');

    const [a, b] = await Promise.all([
      attemptReclaim('a'),
      attemptReclaim('b'),
    ]);
    const winners = [a, b].filter(
      (r) => !r.error && Array.isArray(r.data) && r.data.length > 0,
    );
    // Guaranteed by Postgres row-level locking, not merely likely: the second
    // UPDATE to reach the row blocks until the first commits, then
    // re-evaluates its WHERE clause against the now-current row, whose
    // `updated_at` the winner already refreshed to "now" -- so the loser
    // matches zero rows.
    expect(winners).toHaveLength(1);

    const { data: finalRow, error: finalError } = await supabase
      .from('shipments')
      .select('status, raw_json')
      .eq('id', claimId)
      .single();
    if (finalError) throw finalError;
    expect((finalRow as { status: string }).status).toBe('pending');
  });

  it('demonstrates why the WHERE clause must compare updated_at, not created_at: comparing on created_at lets both concurrent reclaims win', async () => {
    // The flawed alternative shipping.service.ts deliberately avoids. Kept as
    // a live demonstration, not just a comment, of why
    // reclaimStaleShipmentClaim compares `updated_at` (which its own SET
    // clause refreshes) instead of `created_at` (which never changes across a
    // reclaim, so it can never invalidate the WHERE clause for a second
    // concurrent attempt).
    const orderId = await createOrder(orgId);
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: claim, error: claimError } = await supabase
      .from('shipments')
      .insert({
        org_id: orgId,
        order_id: orderId,
        provider: 'ghn',
        status: 'pending',
        fee_vnd: 0,
        raw_json: {},
        created_at: staleIso,
      })
      .select('id')
      .single();
    if (claimError) throw claimError;
    const claimId = (claim as { id: string }).id;

    const cutoffIso = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
    const attemptReclaimOnCreatedAt = () =>
      supabase
        .from('shipments')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', claimId)
        .eq('status', 'pending')
        .lt('created_at', cutoffIso)
        .select('id');

    const [a, b] = await Promise.all([
      attemptReclaimOnCreatedAt(),
      attemptReclaimOnCreatedAt(),
    ]);
    const winners = [a, b].filter(
      (r) => !r.error && Array.isArray(r.data) && r.data.length > 0,
    );
    // `created_at` is untouched by either UPDATE's SET clause, so it never
    // stops matching -- both concurrent attempts win. This is exactly the
    // double-booking race the migration exists to close, reopened by a
    // one-column mistake; it is why the real implementation is NOT written
    // this way.
    expect(winners).toHaveLength(2);
  });
});
