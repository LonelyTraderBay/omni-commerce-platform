import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for the bug where public.receive_po() (the Postgres RPC
 * that backs PurchaseOrder receiving — see SupplierPoService.receivePurchaseOrder
 * in ./supplier-po.service.ts) left product_variants.stock_qty stale after a
 * receive, whenever the variant already had stock sitting in a warehouse
 * other than the one being received into.
 *
 * Root cause: the function aggregated the new total inside a `totals` CTE
 * that is a *sibling* of the `received` CTE (the UPDATE that actually
 * incremented variant_stocks.qty for the receiving warehouse), both inside
 * one multi-CTE `WITH ... UPDATE` statement:
 *
 *   with received as (
 *     update variant_stocks set qty = qty + poi.qty ... returning ...
 *   ),
 *   totals as (
 *     update product_variants set stock_qty = (
 *       select sum(qty) from variant_stocks vs join received r on ... -- STALE
 *     )
 *     ...
 *   )
 *
 * Per Postgres's documented semantics for data-modifying WITH clauses, every
 * sub-statement in one WITH sees the *same* snapshot taken at the start of
 * the statement — a sibling CTE's own writes are visible only through its
 * RETURNING output, never through a fresh scan of the underlying table like
 * `totals` did. So `totals` always summed the PRE-receive quantity for the
 * warehouse that `received` had just updated, meaning receiving a PO never
 * actually moved stock_qty (verified manually via the browser + REST API:
 * receiving 50 units into a warehouse already holding 25, with a second
 * warehouse holding 5, left stock_qty at 30 instead of 80 — even though
 * public.variant_stocks itself was correctly updated to 75). This is exactly
 * the pitfall `private.sync_variant_total_stock` (20260727190000_multi_warehouse.sql)
 * exists to avoid for adjust_variant_stock/transfer_stock — receive_po just
 * didn't reuse it. Fixed in 20260728000000_fix_receive_po_stock_total.sql.
 *
 * This cannot be caught by mocking the Supabase client the way
 * supplier-po.service.spec.ts does: the bug lives entirely inside the SQL
 * function's own multi-CTE snapshot semantics, invisible to anything that
 * doesn't run the real function against a real Postgres. Following the
 * cors.integration.spec.ts precedent of booting the real thing when mocking
 * can't see the bug class, this connects to the local Supabase Postgres
 * (already running via `pnpm run dev:local`) and drives real inserts plus
 * the real receive_po RPC.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54721';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

describe('receive_po RPC (regression: multi-warehouse stock_qty totals)', () => {
  let orgId: string;
  let mainWarehouseId: string;
  let secondWarehouseId: string;
  let variantId: string;
  let poId: string;

  beforeAll(async () => {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: 'Receive PO Regression Org',
        slug: `receive-po-regression-${Date.now()}`,
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

    const { data: supplier, error: supplierError } = await supabase
      .from('suppliers')
      .insert({ org_id: orgId, name: 'Regression Supplier' })
      .select('id')
      .single();
    if (supplierError) throw supplierError;
    const supplierId = (supplier as { id: string }).id;

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({ org_id: orgId, title: 'Regression Product' })
      .select('id')
      .single();
    if (productError) throw productError;
    const productId = (product as { id: string }).id;

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
    // more than one warehouse row before we receive a PO into MAIN — the
    // exact condition that exposed the stale-snapshot bug.
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

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .insert({ org_id: orgId, supplier_id: supplierId, status: 'draft' })
      .select('id')
      .single();
    if (poError) throw poError;
    poId = (po as { id: string }).id;

    const { error: itemError } = await supabase
      .from('purchase_order_items')
      .insert({
        org_id: orgId,
        purchase_order_id: poId,
        variant_id: variantId,
        qty: 7,
        unit_cost_vnd: 5000,
      });
    if (itemError) throw itemError;
  });

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  it('sums stock_qty across every warehouse, not just the one just received into', async () => {
    const { data, error } = await supabase.rpc('receive_po', {
      p_org_id: orgId,
      p_purchase_order_id: poId,
      p_warehouse_id: mainWarehouseId,
      p_actor_user_id: null,
    });

    expect(error).toBeNull();
    expect(
      (data as { movements: Array<{ stockAfter: number }> }).movements[0]
        .stockAfter,
    ).toBe(20); // 13 pre-existing (10 MAIN + 3 AUX) + 7 received

    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .select('stock_qty')
      .eq('org_id', orgId)
      .eq('id', variantId)
      .single();
    if (variantError) throw variantError;
    expect((variant as { stock_qty: number }).stock_qty).toBe(20);

    const { data: mainStock, error: mainStockError } = await supabase
      .from('variant_stocks')
      .select('qty')
      .eq('org_id', orgId)
      .eq('warehouse_id', mainWarehouseId)
      .eq('variant_id', variantId)
      .single();
    if (mainStockError) throw mainStockError;
    expect((mainStock as { qty: number }).qty).toBe(17); // 10 + 7

    const { data: auxStock, error: auxStockError } = await supabase
      .from('variant_stocks')
      .select('qty')
      .eq('org_id', orgId)
      .eq('warehouse_id', secondWarehouseId)
      .eq('variant_id', variantId)
      .single();
    if (auxStockError) throw auxStockError;
    expect((auxStock as { qty: number }).qty).toBe(3); // untouched
  });
});

/**
 * Regression test for the bug where public.receive_po() silently dropped one
 * of two purchase_order_items lines (and mis-attributed COGS) whenever a
 * purchase order carried more than one line for the same variant_id, then
 * masked the data loss behind a misleading 'purchase order receive mismatch'
 * exception.
 *
 * Nothing prevents this shape: SupplierPoService.createPurchaseOrder inserts
 * body.items verbatim with no dedup/validation on variant_id, and
 * purchase_order_items has no unique constraint on
 * (org_id, purchase_order_id, variant_id). A supplier invoice legitimately
 * listing the same SKU across two cost-batches, or a simple operator/UI
 * double-entry, both produce exactly this shape.
 *
 * Root cause (confirmed empirically against local Postgres, not guessed):
 * the pre-fix `received`/`totals` CTEs joined variant_stocks/product_variants
 * directly against the RAW purchase_order_items rows. Per Postgres's
 * documented UPDATE ... FROM semantics, when more than one FROM row matches a
 * single target row, only one of them is used to update it — "not readily
 * predictable" which. With two lines for the same variant (qty 5 @ 4000 VND,
 * qty 3 @ 7000 VND), this silently dropped the qty=3 line entirely: the
 * `received` CTE's own RETURNING showed only qty=5, variant_stocks ended up
 * at 5 (not 8), and only then did the raw-row-count vs actual-movement-count
 * check (2 vs 1) catch the discrepancy and raise 'purchase order receive
 * mismatch', rolling back the whole call. So the exception genuinely does
 * fire — but as an accidental safety net over a deeper silent-data-loss bug,
 * not the real defect. Fixed in
 * 20260729060000_fix_receive_po_duplicate_variant.sql by pre-aggregating
 * purchase_order_items by variant_id (sum(qty), quantity-weighted average of
 * unit_cost_vnd rounded to the nearest VND) before any join, so every
 * downstream join is guaranteed 1:1 regardless of how many raw lines a
 * variant has. See that migration's header comment for the full
 * investigation and the movement-granularity / COGS-aggregation design
 * decisions (one stock_movements row per DISTINCT variant received, not one
 * per raw PO line; quantity-weighted average COGS across duplicate lines).
 */
describe('receive_po RPC (regression: duplicate purchase_order_items lines for the same variant)', () => {
  let orgId: string;
  let warehouseId: string;
  let variantId: string;
  let poId: string;

  beforeAll(async () => {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: 'Receive PO Duplicate Variant Org',
        slug: `receive-po-dup-variant-${Date.now()}`,
      })
      .select('id')
      .single();
    if (orgError) throw orgError;
    orgId = (org as { id: string }).id;

    const { data: warehouse, error: warehouseError } = await supabase
      .from('warehouses')
      .select('id')
      .eq('org_id', orgId)
      .eq('is_default', true)
      .single();
    if (warehouseError) throw warehouseError;
    warehouseId = (warehouse as { id: string }).id;

    const { data: supplier, error: supplierError } = await supabase
      .from('suppliers')
      .insert({ org_id: orgId, name: 'Duplicate Variant Supplier' })
      .select('id')
      .single();
    if (supplierError) throw supplierError;
    const supplierId = (supplier as { id: string }).id;

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({ org_id: orgId, title: 'Duplicate Variant Product' })
      .select('id')
      .single();
    if (productError) throw productError;
    const productId = (product as { id: string }).id;

    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .insert({
        org_id: orgId,
        product_id: productId,
        sku: `DUP-${Date.now()}`,
        title: 'Duplicate Variant',
        price_vnd: 10000,
        stock_qty: 0,
      })
      .select('id')
      .single();
    if (variantError) throw variantError;
    variantId = (variant as { id: string }).id;

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .insert({ org_id: orgId, supplier_id: supplierId, status: 'draft' })
      .select('id')
      .single();
    if (poError) throw poError;
    poId = (po as { id: string }).id;

    // TWO line items referencing the SAME variant_id — different qty AND
    // different unit_cost_vnd. Nothing at the schema or service layer
    // prevents this; receive_po must handle it correctly rather than reject
    // it (see this migration's header comment for why).
    const { error: itemError } = await supabase
      .from('purchase_order_items')
      .insert([
        {
          org_id: orgId,
          purchase_order_id: poId,
          variant_id: variantId,
          qty: 5,
          unit_cost_vnd: 4000,
        },
        {
          org_id: orgId,
          purchase_order_id: poId,
          variant_id: variantId,
          qty: 3,
          unit_cost_vnd: 7000,
        },
      ]);
    if (itemError) throw itemError;
  });

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  it('sums qty across duplicate lines and computes a quantity-weighted average COGS, without raising a spurious mismatch', async () => {
    const { data, error } = await supabase.rpc('receive_po', {
      p_org_id: orgId,
      p_purchase_order_id: poId,
      p_warehouse_id: warehouseId,
      p_actor_user_id: null,
    });

    expect(error).toBeNull();

    const payload = data as {
      status: string;
      movements: Array<{
        variantId: string;
        qtyDelta: number;
        stockAfter: number;
      }>;
    };
    expect(payload.status).toBe('received');
    // Exactly ONE stock_movements row for the one distinct variant actually
    // received — not one row per raw purchase_order_items line.
    expect(payload.movements).toHaveLength(1);
    expect(payload.movements[0].variantId).toBe(variantId);
    expect(payload.movements[0].qtyDelta).toBe(8); // 5 + 3, summed
    expect(payload.movements[0].stockAfter).toBe(8);

    const { data: variant, error: variantError } = await supabase
      .from('product_variants')
      .select('stock_qty, cogs_vnd')
      .eq('org_id', orgId)
      .eq('id', variantId)
      .single();
    if (variantError) throw variantError;
    expect((variant as { stock_qty: number }).stock_qty).toBe(8);
    // Quantity-weighted average: (5*4000 + 3*7000) / 8 = 5125
    expect(
      Number((variant as { cogs_vnd: number | string }).cogs_vnd),
    ).toBe(5125);

    const { data: stock, error: stockError } = await supabase
      .from('variant_stocks')
      .select('qty')
      .eq('org_id', orgId)
      .eq('warehouse_id', warehouseId)
      .eq('variant_id', variantId)
      .single();
    if (stockError) throw stockError;
    expect((stock as { qty: number }).qty).toBe(8);

    const { data: movements, error: movementsError } = await supabase
      .from('stock_movements')
      .select('qty_delta, stock_after')
      .eq('org_id', orgId)
      .eq('variant_id', variantId);
    if (movementsError) throw movementsError;
    expect(movements).toHaveLength(1);
    expect((movements as Array<{ qty_delta: number }>)[0].qty_delta).toBe(8);

    const { data: purchaseOrder, error: purchaseOrderError } = await supabase
      .from('purchase_orders')
      .select('status')
      .eq('id', poId)
      .single();
    if (purchaseOrderError) throw purchaseOrderError;
    expect((purchaseOrder as { status: string }).status).toBe('received');
  });
});

/**
 * Stronger regression check for the same fix: a PO that mixes a duplicated
 * variant (two lines) with an ordinary single-line variant in the SAME
 * receive_po call. This exercises the reconciliation invariant
 * (v_movement_count vs v_required_count, both now counting DISTINCT variants)
 * across more than one distinct variant per call, which a PO containing only
 * one (duplicated) variant cannot distinguish from a naive/incorrect fix.
 */
describe('receive_po RPC (regression: mixed PO — one duplicated variant plus one single-line variant)', () => {
  let orgId: string;
  let warehouseId: string;
  let variantAId: string;
  let variantBId: string;
  let poId: string;

  beforeAll(async () => {
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({
        name: 'Receive PO Mixed Duplicate Variant Org',
        slug: `receive-po-mixed-dup-variant-${Date.now()}`,
      })
      .select('id')
      .single();
    if (orgError) throw orgError;
    orgId = (org as { id: string }).id;

    const { data: warehouse, error: warehouseError } = await supabase
      .from('warehouses')
      .select('id')
      .eq('org_id', orgId)
      .eq('is_default', true)
      .single();
    if (warehouseError) throw warehouseError;
    warehouseId = (warehouse as { id: string }).id;

    const { data: supplier, error: supplierError } = await supabase
      .from('suppliers')
      .insert({ org_id: orgId, name: 'Mixed Duplicate Variant Supplier' })
      .select('id')
      .single();
    if (supplierError) throw supplierError;
    const supplierId = (supplier as { id: string }).id;

    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({ org_id: orgId, title: 'Mixed Duplicate Variant Product' })
      .select('id')
      .single();
    if (productError) throw productError;
    const productId = (product as { id: string }).id;

    const { data: variantA, error: variantAError } = await supabase
      .from('product_variants')
      .insert({
        org_id: orgId,
        product_id: productId,
        sku: `MIXDUP-A-${Date.now()}`,
        title: 'Mixed Duplicate Variant A',
        price_vnd: 10000,
        stock_qty: 0,
      })
      .select('id')
      .single();
    if (variantAError) throw variantAError;
    variantAId = (variantA as { id: string }).id;

    const { data: variantB, error: variantBError } = await supabase
      .from('product_variants')
      .insert({
        org_id: orgId,
        product_id: productId,
        sku: `MIXDUP-B-${Date.now()}`,
        title: 'Mixed Duplicate Variant B',
        price_vnd: 20000,
        stock_qty: 0,
      })
      .select('id')
      .single();
    if (variantBError) throw variantBError;
    variantBId = (variantB as { id: string }).id;

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .insert({ org_id: orgId, supplier_id: supplierId, status: 'draft' })
      .select('id')
      .single();
    if (poError) throw poError;
    poId = (po as { id: string }).id;

    const { error: itemError } = await supabase
      .from('purchase_order_items')
      .insert([
        {
          org_id: orgId,
          purchase_order_id: poId,
          variant_id: variantAId,
          qty: 5,
          unit_cost_vnd: 4000,
        },
        {
          org_id: orgId,
          purchase_order_id: poId,
          variant_id: variantAId,
          qty: 3,
          unit_cost_vnd: 7000,
        },
        {
          org_id: orgId,
          purchase_order_id: poId,
          variant_id: variantBId,
          qty: 10,
          unit_cost_vnd: 9000,
        },
      ]);
    if (itemError) throw itemError;
  });

  afterAll(async () => {
    if (orgId) {
      await supabase.from('organizations').delete().eq('id', orgId);
    }
  });

  it('reconciles one movement per distinct variant even when only some variants on the PO are duplicated', async () => {
    const { data, error } = await supabase.rpc('receive_po', {
      p_org_id: orgId,
      p_purchase_order_id: poId,
      p_warehouse_id: warehouseId,
      p_actor_user_id: null,
    });

    expect(error).toBeNull();

    const payload = data as {
      status: string;
      movements: Array<{ variantId: string; qtyDelta: number }>;
    };
    expect(payload.status).toBe('received');
    // 3 raw PO lines, but only 2 distinct variants -> 2 movements.
    expect(payload.movements).toHaveLength(2);

    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id, stock_qty, cogs_vnd')
      .in('id', [variantAId, variantBId]);
    if (variantsError) throw variantsError;
    const bySku = new Map(
      (variants as Array<{ id: string; stock_qty: number; cogs_vnd: number | string }>).map(
        (v) => [v.id, v],
      ),
    );

    const variantA = bySku.get(variantAId);
    expect(variantA?.stock_qty).toBe(8); // 5 + 3
    expect(Number(variantA?.cogs_vnd)).toBe(5125); // weighted average

    const variantB = bySku.get(variantBId);
    expect(variantB?.stock_qty).toBe(10); // single line, untouched by aggregation
    expect(Number(variantB?.cogs_vnd)).toBe(9000);

    // stock_movements has no purchase_order_id column; the reason field
    // ('receive_po:<uuid>') is how this RPC's own movements are identified,
    // consistent with the query receive_po itself uses to build its
    // `movements` response payload.
    const { data: movements, error: movementsError } = await supabase
      .from('stock_movements')
      .select('variant_id, qty_delta')
      .eq('org_id', orgId)
      .eq('reason', `receive_po:${poId}`);
    if (movementsError) throw movementsError;
    expect(movements).toHaveLength(2);
  });
});
