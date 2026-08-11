import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueOutbox } from '../../jobs/outbox.publisher';

/**
 * Regression test for the auto-confirm order path losing its lifecycle events.
 *
 * public.create_and_confirm_order (20260727170000_order_attribution.sql) commits
 * the order, its items, the stock decrement and the 201 idempotency row in ONE
 * transaction. OrdersService.createDraftOrder then made three *separate*
 * PostgREST calls afterwards: enqueue `order.created`, write the confirm audit,
 * enqueue `order.confirmed`.
 *
 * A process death (deploy, OOM, kill) in that window left an order that is
 * `confirmed` with stock already decremented but with no outbox row at all, and
 * the retry could not repair it: the committed idempotency row makes the RPC
 * return `_idempotencyReplayed = true`, and the caller skips the enqueue on that
 * path by design. The events were gone for good, so every subscribed merchant
 * webhook missed the order.
 *
 * 20260729040000_create_and_confirm_order_transactional_outbox.sql moves the two
 * enqueues inside the function, following the precedent set by
 * create_product_with_variants_and_reindex.
 *
 * None of this is visible to a mocked Supabase client: the guarantee under test
 * is Postgres transaction atomicity across a function body, which only exists
 * when the real function runs against a real database. Following the
 * apply-order-stock-change.integration.spec.ts precedent, this drives the local
 * Supabase (`pnpm run dev:local`) directly.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54721';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const INITIAL_STOCK = 10;
const ORDER_QTY = 3;

type OutboxRow = {
  id: string;
  org_id: string;
  event_name: string;
  payload_json: Record<string, unknown>;
  published_at: string | null;
  attempts: number;
};

async function createOrg(slugPrefix: string) {
  const { data, error } = await supabase
    .from('organizations')
    .insert({
      name: 'Create And Confirm Outbox Regression Org',
      slug: `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function readOutbox(orgId: string) {
  const { data, error } = await supabase
    .from('outbox_events')
    .select('id, org_id, event_name, payload_json, published_at, attempts')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OutboxRow[];
}

async function readStock(variantId: string) {
  const { data, error } = await supabase
    .from('product_variants')
    .select('stock_qty')
    .eq('id', variantId)
    .single();
  if (error) throw error;
  return (data as { stock_qty: number }).stock_qty;
}

describe('create_and_confirm_order RPC (regression: lifecycle events lost when the process died after commit)', () => {
  let orgId: string;
  let productId: string;
  let variantId: string;
  let orderId: string;

  const idempotencyKey = `auto-confirm-${Date.now()}`;

  function rpcArgs(overrides: Record<string, unknown> = {}) {
    return {
      p_org_id: orgId,
      p_conversation_id: null,
      p_contact_id: null,
      p_payment_method: 'cod',
      p_customer_name: 'Nguyen Van A',
      p_phone_e164: '+84900000001',
      p_address_text: 'Ha Noi',
      p_address_json: {},
      p_idempotency_key: idempotencyKey,
      p_items: [
        {
          product_id: productId,
          variant_id: variantId,
          title_snapshot: 'Regression Variant',
          sku_snapshot: 'CACO-1',
          qty: ORDER_QTY,
          unit_price_vnd: '1000',
          line_total_vnd: String(1000 * ORDER_QTY),
          cogs_unit_vnd: '0',
        },
      ],
      p_method: 'POST',
      p_path: '/v1/orders',
      p_status_code: 201,
      p_confirmed_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    orgId = await createOrg('create-and-confirm-outbox');

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({ org_id: orgId, title: 'Regression Product' })
      .select('id')
      .single();
    if (productError) throw productError;
    productId = (product as { id: string }).id;

    // Inserting a variant auto-creates its MAIN variant_stocks row via the
    // ensure_variant_stock_main trigger, seeded from stock_qty.
    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .insert({
        org_id: orgId,
        product_id: productId,
        sku: `CACO-${Date.now()}`,
        title: 'Regression Variant',
        price_vnd: 1000,
        stock_qty: INITIAL_STOCK,
      })
      .select('id')
      .single();
    if (variantError) throw variantError;
    variantId = (variant as { id: string }).id;
  });

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  it('commits the order together with exactly one order.created and one order.confirmed', async () => {
    const { data, error } = await supabase.rpc(
      'create_and_confirm_order',
      rpcArgs(),
    );

    expect(error).toBeNull();
    const payload = data as {
      order: { id: string; status: string };
      _idempotencyReplayed: boolean;
    };
    expect(payload._idempotencyReplayed).toBe(false);
    expect(payload.order.status).toBe('confirmed');
    orderId = payload.order.id;

    const rows = await readOutbox(orgId);
    expect(rows).toHaveLength(2);
    // Ordered the way OutboxPublisher.publishPending reads them.
    expect(rows.map((row) => row.event_name)).toEqual([
      'order.created',
      'order.confirmed',
    ]);

    // `toEqual`, not `objectContaining`: the payload must carry these three
    // fields and nothing else, because order-webhook-dispatch parses exactly
    // `event` / `orderId` / `status` (plus `orgId` + `outboxEventId`, which the
    // publisher merges in from the row's own columns).
    expect(rows[0]?.payload_json).toEqual({
      event: 'order.created',
      orderId,
      status: 'draft',
    });
    expect(rows[1]?.payload_json).toEqual({
      event: 'order.confirmed',
      orderId,
      status: 'confirmed',
    });

    for (const row of rows) {
      expect(row.org_id).toBe(orgId);
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(0);
    }

    expect(await readStock(variantId)).toBe(INITIAL_STOCK - ORDER_QTY);
  });

  it('does not enqueue a second pair, nor decrement stock again, when the same key is replayed', async () => {
    const { data, error } = await supabase.rpc(
      'create_and_confirm_order',
      rpcArgs(),
    );

    expect(error).toBeNull();
    const payload = data as {
      order: { id: string };
      _idempotencyReplayed: boolean;
    };
    expect(payload._idempotencyReplayed).toBe(true);
    expect(payload.order.id).toBe(orderId);

    // The whole point: the replay returns the stored response *before* reaching
    // the outbox insert, so the events stay at exactly one pair. Emitting them
    // from the caller after the RPC (as this path used to) is what made the
    // events either lost or, if the caller stopped checking `replayed`,
    // duplicated.
    const rows = await readOutbox(orgId);
    expect(rows).toHaveLength(2);

    // The catastrophic failure mode this whole RPC exists to prevent.
    expect(await readStock(variantId)).toBe(INITIAL_STOCK - ORDER_QTY);

    const { count, error: countError } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);
    if (countError) throw countError;
    expect(count).toBe(1);
  });

  it('leaves no outbox rows behind when the call fails after the enqueue', async () => {
    const before = await readOutbox(orgId);
    // Pinned so this test cannot pass vacuously against a build that never
    // enqueues anything (0 before == 0 after).
    expect(before).toHaveLength(2);

    // `p_status_code` lands in `idempotency_keys.status_code`, which is checked
    // to be between 100 and 599. That UPDATE is the last statement of the
    // function — strictly *after* the outbox insert — so 999 is a way to fail
    // the transaction at a point where the two events are already written.
    // Nothing weaker would prove atomicity: an insufficient-stock failure
    // aborts before the insert is ever reached.
    const { error } = await supabase.rpc(
      'create_and_confirm_order',
      rpcArgs({
        p_idempotency_key: `${idempotencyKey}-rollback`,
        p_status_code: 999,
      }),
    );

    expect(error).not.toBeNull();
    expect(error?.message ?? '').toContain(
      'idempotency_keys_status_code_check',
    );

    // No new events, no second order, no wedged idempotency row, no stock lost.
    expect(await readOutbox(orgId)).toHaveLength(before.length);
    expect(await readStock(variantId)).toBe(INITIAL_STOCK - ORDER_QTY);

    const { count, error: countError } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);
    if (countError) throw countError;
    expect(count).toBe(1);

    const { data: idempotencyRow, error: idempotencyError } = await supabase
      .from('idempotency_keys')
      .select('key')
      .eq('org_id', orgId)
      .eq('key', `${idempotencyKey}-rollback`)
      .maybeSingle();
    if (idempotencyError) throw idempotencyError;
    expect(idempotencyRow).toBeNull();
  });
});

describe('create_and_confirm_order outbox rows are indistinguishable from enqueueOutbox rows', () => {
  let orgId: string;
  let productId: string;
  let variantId: string;

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  beforeAll(async () => {
    orgId = await createOrg('create-and-confirm-outbox-parity');

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({ org_id: orgId, title: 'Parity Product' })
      .select('id')
      .single();
    if (productError) throw productError;
    productId = (product as { id: string }).id;

    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .insert({
        org_id: orgId,
        product_id: productId,
        sku: `PARITY-${Date.now()}`,
        title: 'Parity Variant',
        price_vnd: 1000,
        stock_qty: INITIAL_STOCK,
      })
      .select('id')
      .single();
    if (variantError) throw variantError;
    variantId = (variant as { id: string }).id;
  });

  it('writes the same columns the TypeScript enqueue writes for the same event', async () => {
    const { data, error } = await supabase.rpc('create_and_confirm_order', {
      p_org_id: orgId,
      p_conversation_id: null,
      p_contact_id: null,
      p_payment_method: 'cod',
      p_customer_name: null,
      p_phone_e164: null,
      p_address_text: null,
      p_address_json: {},
      p_idempotency_key: `parity-${Date.now()}`,
      p_items: [
        {
          product_id: productId,
          variant_id: variantId,
          title_snapshot: 'Parity Variant',
          sku_snapshot: 'PARITY-1',
          qty: 1,
          unit_price_vnd: '1000',
          line_total_vnd: '1000',
          cogs_unit_vnd: '0',
        },
      ],
      p_method: 'POST',
      p_path: '/v1/orders',
      p_status_code: 201,
      p_confirmed_at: new Date().toISOString(),
    });
    if (error) throw error;
    const orderId = (data as { order: { id: string } }).order.id;

    const rpcRows = await readOutbox(orgId);
    expect(rpcRows).toHaveLength(2);

    // Now produce the same two events the way every *other* lifecycle
    // transition still does — OrdersService.enqueueOrderEvent -> enqueueOutbox.
    await enqueueOutbox(supabase, {
      orgId,
      eventName: 'order.created',
      payload: { event: 'order.created', orderId, status: 'draft' },
    });
    await enqueueOutbox(supabase, {
      orgId,
      eventName: 'order.confirmed',
      payload: { event: 'order.confirmed', orderId, status: 'confirmed' },
    });

    const allRows = await readOutbox(orgId);
    expect(allRows).toHaveLength(4);
    const tsRows = allRows.slice(2);

    const comparable = (row: OutboxRow) => ({
      org_id: row.org_id,
      event_name: row.event_name,
      payload_json: row.payload_json,
      published_at: row.published_at,
      attempts: row.attempts,
    });

    // Every column the publisher and the dispatcher look at is identical, so
    // `order-webhook-dispatch` cannot tell which producer wrote the row.
    expect(rpcRows.map(comparable)).toEqual(tsRows.map(comparable));
  });
});
