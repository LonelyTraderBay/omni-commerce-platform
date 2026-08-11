import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  InventoryService,
  type SupabaseLike,
} from './inventory.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const VARIANT_ID = '33333333-3333-3333-3333-333333333333';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const MOVEMENT_ID = '55555555-5555-5555-5555-555555555555';
const CREATED_AT = '2026-07-25T01:00:00.000Z';

function variantRow(stockQty = 10) {
  return {
    id: VARIANT_ID,
    org_id: ORG_ID,
    product_id: PRODUCT_ID,
    sku: 'SKU-1',
    title: 'Variant',
    price_vnd: '10000',
    stock_qty: stockQty,
    attrs_json: {},
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function movementRow(qtyDelta = -2, stockAfter = 8) {
  return {
    id: MOVEMENT_ID,
    org_id: ORG_ID,
    variant_id: VARIANT_ID,
    movement_type: 'adjust',
    qty_delta: qtyDelta,
    stock_after: stockAfter,
    order_id: null,
    reason: 'cycle count',
    actor_user_id: null,
    created_at: CREATED_AT,
  };
}

describe('InventoryService', () => {
  it('lists movements filtered by variant', async () => {
    const calls: Array<{ table: string; filters: string[] }> = [];
    const supabase: SupabaseLike = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from(table: string) {
        const filters: string[] = [];
        calls.push({ table, filters });
        const chain = {
          select() {
            return chain;
          },
          eq(column: string, value: string) {
            filters.push(`${column}=${value}`);
            return chain;
          },
          order() {
            return chain;
          },
          limit() {
            return chain;
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve(
              resolve({ data: [movementRow()], error: null }),
            );
          },
        };
        return chain;
      },
    };

    const service = new InventoryService(supabase);
    const result = await service.listMovements(ORG_ID, {
      variantId: VARIANT_ID,
      limit: 20,
    });

    expect(calls[0]?.table).toBe('stock_movements');
    expect(calls[0]?.filters).toContain(`variant_id=${VARIANT_ID}`);
    expect(result.movements[0]?.qtyDelta).toBe(-2);
  });

  it('lists low-stock using org threshold when omitted', async () => {
    const supabase: SupabaseLike = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from(table: string) {
        if (table === 'organizations') {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data: { low_stock_threshold: 3 },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }

        const chain = {
          select() {
            return chain;
          },
          eq() {
            return chain;
          },
          lte(column: string, value: number) {
            expect(column).toBe('stock_qty');
            expect(value).toBe(3);
            return chain;
          },
          order() {
            return chain;
          },
          limit() {
            return {
              then(resolve: (value: unknown) => unknown) {
                return Promise.resolve(
                  resolve({ data: [variantRow(2)], error: null }),
                );
              },
            };
          },
        };
        return chain;
      },
    };

    const service = new InventoryService(supabase);
    const result = await service.listLowStock(ORG_ID, {});
    expect(result.threshold).toBe(3);
    expect(result.variants[0]?.stockQty).toBe(2);
  });

  it('adjusts stock via RPC and maps insufficient stock', async () => {
    const supabase: SupabaseLike = {
      from() {
        throw new Error('from should not be called');
      },
      rpc: async () => ({
        data: null,
        error: {
          hint: 'insufficient_stock',
          message: 'insufficient stock for adjust',
        },
      }),
    } as unknown as SupabaseLike;

    const service = new InventoryService(supabase);
    await expect(
      service.adjust(ORG_ID, {
        variantId: VARIANT_ID,
        qtyDelta: -99,
        movementType: 'adjust',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setStockQty no-ops when target equals current', async () => {
    let calls = 0;
    const supabase: SupabaseLike = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from() {
        calls += 1;
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () =>
                        calls === 1
                          ? { data: { stock_qty: 7 }, error: null }
                          : { data: variantRow(7), error: null },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseLike;

    const service = new InventoryService(supabase);
    const result = await service.setStockQty({
      orgId: ORG_ID,
      variantId: VARIANT_ID,
      targetQty: 7,
    });
    expect(result.movement).toBeNull();
    expect(result.variant.stockQty).toBe(7);
  });

  it('setStockQty throws when variant missing', async () => {
    const supabase: SupabaseLike = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({ data: null, error: null }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseLike;

    const service = new InventoryService(supabase);
    await expect(
      service.setStockQty({
        orgId: ORG_ID,
        variantId: VARIANT_ID,
        targetQty: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
