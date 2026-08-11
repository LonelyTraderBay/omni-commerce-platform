import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for the bug where private.apply_order_stock_change()
 * (the Postgres RPC that public.confirm_order / cancel_order / return_order
 * call to adjust stock — see OrdersService.confirmOrder/cancelOrder/returnOrder
 * in ./orders.service.ts) left product_variants.stock_qty stale after a
 * confirm or cancel, whenever the variant already had stock sitting in a
 * warehouse other than the default one being adjusted.
 *
 * Root cause: the same bug class as public.receive_po() before
 * 20260728000000_fix_receive_po_stock_total.sql. The pre-fix definition
 * (20260727210000_ensure_default_warehouse_on_org.sql) aggregated the new
 * total inside a `totals` CTE that is a *sibling* of the `updated_stocks`
 * CTE (the UPDATE that actually adjusted variant_stocks.qty for the default
 * warehouse), both inside one multi-CTE `WITH ... UPDATE` statement:
 *
 *   with updated_stocks as (
 *     update variant_stocks set qty = qty + (mult * required.qty) ... returning ...
 *   ),
 *   totals as (
 *     update product_variants set stock_qty = (
 *       select sum(qty) from variant_stocks vs join updated_stocks u on ... -- STALE
 *     )
 *     ...
 *   )
 *
 * Per Postgres's documented semantics for data-modifying WITH clauses, every
 * sub-statement in one WITH sees the *same* snapshot taken at the start of
 * the statement — a sibling CTE's own writes are visible only through its
 * RETURNING output, never through a fresh scan of the underlying table like
 * `totals` did. So `totals` always summed the PRE-change quantity for the
 * warehouse `updated_stocks` had just adjusted, meaning confirming/
 * cancelling an order left stock_qty unchanged (wrong) whenever the variant
 * also had stock in another warehouse. Fixed in
 * 20260728010000_fix_apply_order_stock_change_total.sql, reusing the same
 * fix shape as receive_po: total_qty = updated_stocks.warehouse_stock_after
 * (guaranteed correct via RETURNING) + a fresh sum of the OTHER warehouses'
 * rows only (safe, since this statement never touches them).
 *
 * This cannot be caught by mocking the Supabase client the way
 * orders.service.spec.ts does: the bug lives entirely inside the SQL
 * function's own multi-CTE snapshot semantics, invisible to anything that
 * doesn't run the real function against a real Postgres. Following the
 * receive-po.integration.spec.ts precedent, this connects to the local
 * Supabase Postgres (already running via `pnpm run dev:local`) and drives
 * real inserts plus the real confirm_order/cancel_order RPCs.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54721';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

describe('apply_order_stock_change RPC (regression: multi-warehouse stock_qty totals)', () => {
  let orgId: string;
  let mainWarehouseId: string;
  let secondWarehouseId: string;
  let productId: string;
  let variantId: string;
  let orderId: string;

  beforeAll(async () => {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: 'Apply Order Stock Change Regression Org',
        slug: `apply-order-stock-change-regression-${Date.now()}`,
      })
      .select('id')
      .single();
    if (orgError) throw orgError;
    orgId = (org as { id: string }).id;

    // Inserting an org auto-creates a default "MAIN" warehouse via the
    // organizations_ensure_default_warehouse trigger.
    const { data: mainWarehouse, error: warehouseError } = await supabase
      .from('warehouses')
      .select('id')
      .eq('org_id', orgId)
      .eq('is_default', true)
      .single();
    if (warehouseError) throw warehouseError;
    mainWarehouseId = (mainWarehouse as { id: string }).id;

    const { data: secondWarehouse, error: secondWarehouseError } =
      await supabase
        .from('warehouses')
        .insert({ org_id: orgId, name: 'Kho phụ', code: 'AUX' })
        .select('id')
        .single();
    if (secondWarehouseError) throw secondWarehouseError;
    secondWarehouseId = (secondWarehouse as { id: string }).id;

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({ org_id: orgId, title: 'Regression Product' })
      .select('id')
      .single();
    if (productError) throw productError;
    productId = (product as { id: string }).id;

    // Inserting a variant auto-creates its MAIN variant_stocks row via the
    // ensure_variant_stock_main trigger, seeded from stock_qty below.
    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .insert({
        org_id: orgId,
        product_id: productId,
        sku: `REG-${Date.now()}`,
        title: 'Regression Variant',
        price_vnd: 10000,
        stock_qty: 10,
      })
      .select('id')
      .single();
    if (variantError) throw variantError;
    variantId = (variant as { id: string }).id;

    // Simulate stock that already exists in a *second* warehouse (e.g. from
    // an earlier transfer_stock call) so the variant has qty split across
    // more than one warehouse row before we confirm an order against MAIN —
    // the exact condition that exposed the stale-snapshot bug.
    const { error: secondStockError } = await supabase
      .from('variant_stocks')
      .insert({
        org_id: orgId,
        warehouse_id: secondWarehouseId,
        variant_id: variantId,
        qty: 3,
      });
    if (secondStockError) throw secondStockError;

    const { error: totalError } = await supabase
      .from('product_variants')
      .update({ stock_qty: 13 }) // 10 (MAIN) + 3 (AUX), matching reality
      .eq('org_id', orgId)
      .eq('id', variantId);
    if (totalError) throw totalError;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        org_id: orgId,
        status: 'draft',
        payment_method: 'cod',
        subtotal_vnd: 40000,
        total_vnd: 40000,
      })
      .select('id')
      .single();
    if (orderError) throw orderError;
    orderId = (order as { id: string }).id;

    const { error: itemError } = await supabase.from('order_items').insert({
      org_id: orgId,
      order_id: orderId,
      product_id: productId,
      variant_id: variantId,
      title_snapshot: 'Regression Variant',
      sku_snapshot: `REG-${Date.now()}`,
      qty: 4,
      unit_price_vnd: 10000,
      line_total_vnd: 40000,
    });
    if (itemError) throw itemError;
  });

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  it('sums stock_qty across every warehouse on confirm, not just the default one', async () => {
    const { data, error } = await supabase.rpc('confirm_order', {
      p_org_id: orgId,
      p_order_id: orderId,
    });

    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .select('stock_qty')
      .eq('org_id', orgId)
      .eq('id', variantId)
      .single();
    if (variantError) throw variantError;
    // 13 pre-existing (10 MAIN + 3 AUX) - 4 confirmed = 9.
    expect((variant as { stock_qty: number }).stock_qty).toBe(9);

    const { data: mainStock, error: mainStockError } = await supabase
      .from('variant_stocks')
      .select('qty')
      .eq('org_id', orgId)
      .eq('warehouse_id', mainWarehouseId)
      .eq('variant_id', variantId)
      .single();
    if (mainStockError) throw mainStockError;
    expect((mainStock as { qty: number }).qty).toBe(6); // 10 - 4

    const { data: auxStock, error: auxStockError } = await supabase
      .from('variant_stocks')
      .select('qty')
      .eq('org_id', orgId)
      .eq('warehouse_id', secondWarehouseId)
      .eq('variant_id', variantId)
      .single();
    if (auxStockError) throw auxStockError;
    expect((auxStock as { qty: number }).qty).toBe(3); // untouched

    // Now cancel the confirmed order: stock should be restored the same way,
    // exercising the 'cancel_restore' direction of the same fixed function.
    const { error: cancelError } = await supabase.rpc('cancel_order', {
      p_org_id: orgId,
      p_order_id: orderId,
    });
    expect(cancelError).toBeNull();

    const { data: variantAfterCancel, error: variantAfterCancelError } =
      await supabase
        .from('product_variants')
        .select('stock_qty')
        .eq('org_id', orgId)
        .eq('id', variantId)
        .single();
    if (variantAfterCancelError) throw variantAfterCancelError;
    // Back to 13 (10 MAIN + 3 AUX).
    expect((variantAfterCancel as { stock_qty: number }).stock_qty).toBe(13);

    const { data: mainStockAfterCancel, error: mainStockAfterCancelError } =
      await supabase
        .from('variant_stocks')
        .select('qty')
        .eq('org_id', orgId)
        .eq('warehouse_id', mainWarehouseId)
        .eq('variant_id', variantId)
        .single();
    if (mainStockAfterCancelError) throw mainStockAfterCancelError;
    expect((mainStockAfterCancel as { qty: number }).qty).toBe(10); // 6 + 4
  });
});
