import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  WarehousesService,
  type SupabaseLike,
} from './warehouses.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const FROM_WAREHOUSE_ID = '22222222-2222-2222-2222-222222222222';
const TO_WAREHOUSE_ID = '33333333-3333-3333-3333-333333333333';
const VARIANT_ID = '44444444-4444-4444-4444-444444444444';
const PRODUCT_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '66666666-6666-6666-6666-666666666666';
const CREATED_AT = '2026-07-25T01:00:00.000Z';

function warehouseRow(input: {
  id?: string;
  name?: string;
  code?: string;
  isDefault?: boolean;
} = {}) {
  return {
    id: input.id ?? FROM_WAREHOUSE_ID,
    org_id: ORG_ID,
    name: input.name ?? 'Kho chính',
    code: input.code ?? 'MAIN',
    is_default: input.isDefault ?? true,
    created_at: CREATED_AT,
  };
}

function variantRow() {
  return {
    id: VARIANT_ID,
    org_id: ORG_ID,
    product_id: PRODUCT_ID,
    sku: 'SKU-1',
    title: 'Variant',
    price_vnd: '10000',
    stock_qty: 10,
    cogs_vnd: '5000',
    attrs_json: {},
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

describe('WarehousesService', () => {
  it('lists warehouses for the current org', async () => {
    const calls: Array<{ table: string; filters: string[] }> = [];
    const client = {
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
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve(
              resolve({ data: [warehouseRow()], error: null }),
            );
          },
        };
        return chain;
      },
    } as unknown as SupabaseLike;

    const service = new WarehousesService(client);
    const result = await service.listWarehouses(ORG_ID);

    expect(calls[0]?.table).toBe('warehouses');
    expect(calls[0]?.filters).toContain(`org_id=${ORG_ID}`);
    expect(result.warehouses[0]).toMatchObject({
      id: FROM_WAREHOUSE_ID,
      code: 'MAIN',
      isDefault: true,
    });
  });

  it('creates a warehouse scoped to the org', async () => {
    const inserted: unknown[] = [];
    const client = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from(table: string) {
        expect(table).toBe('warehouses');
        return {
          insert(row: unknown) {
            inserted.push(row);
            return {
              select() {
                return {
                  single: async () => ({
                    data: warehouseRow({
                      id: TO_WAREHOUSE_ID,
                      name: 'Kho phụ',
                      code: 'BR2',
                      isDefault: false,
                    }),
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseLike;

    const service = new WarehousesService(client);
    const result = await service.createWarehouse(ORG_ID, {
      name: 'Kho phụ',
      code: 'BR2',
      isDefault: false,
    });

    expect(inserted[0]).toEqual({
      org_id: ORG_ID,
      name: 'Kho phụ',
      code: 'BR2',
      is_default: false,
    });
    expect(result.warehouse.id).toBe(TO_WAREHOUSE_ID);
  });

  it('lists stock with nested variant data', async () => {
    const client = {
      rpc() {
        throw new Error('rpc should not be called');
      },
      from(table: string) {
        if (table === 'warehouses') {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({
                          data: warehouseRow(),
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        }

        expect(table).toBe('variant_stocks');
        const chain = {
          select() {
            return chain;
          },
          eq() {
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
              resolve({
                data: [
                  {
                    org_id: ORG_ID,
                    warehouse_id: FROM_WAREHOUSE_ID,
                    variant_id: VARIANT_ID,
                    qty: 7,
                    product_variants: variantRow(),
                  },
                ],
                error: null,
              }),
            );
          },
        };
        return chain;
      },
    } as unknown as SupabaseLike;

    const service = new WarehousesService(client);
    const result = await service.getWarehouseStock(ORG_ID, FROM_WAREHOUSE_ID);

    expect(result.warehouse.code).toBe('MAIN');
    expect(result.stock[0]).toMatchObject({
      warehouseId: FROM_WAREHOUSE_ID,
      variantId: VARIANT_ID,
      qty: 7,
      variant: { sku: 'SKU-1' },
    });
  });

  it('transfers stock via RPC with actor and reason', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        variant: {
          id: VARIANT_ID,
          orgId: ORG_ID,
          productId: PRODUCT_ID,
          sku: 'SKU-1',
          title: 'Variant',
          priceVnd: '10000',
          stockQty: 10,
          cogsVnd: '5000',
          attrs: {},
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
        fromStock: {
          warehouseId: FROM_WAREHOUSE_ID,
          variantId: VARIANT_ID,
          qty: 4,
        },
        toStock: {
          warehouseId: TO_WAREHOUSE_ID,
          variantId: VARIANT_ID,
          qty: 6,
        },
        movements: [],
      },
      error: null,
    }));
    const client = {
      rpc,
      from() {
        throw new Error('from should not be called');
      },
    } as unknown as SupabaseLike;

    const service = new WarehousesService(client);
    const result = await service.transferStock(
      ORG_ID,
      {
        fromWarehouseId: FROM_WAREHOUSE_ID,
        toWarehouseId: TO_WAREHOUSE_ID,
        variantId: VARIANT_ID,
        qty: 3,
        reason: 'chuyển kho',
      },
      USER_ID,
    );

    expect(rpc).toHaveBeenCalledWith('transfer_stock', {
      p_org_id: ORG_ID,
      p_from_warehouse_id: FROM_WAREHOUSE_ID,
      p_to_warehouse_id: TO_WAREHOUSE_ID,
      p_variant_id: VARIANT_ID,
      p_qty: 3,
      p_actor_user_id: USER_ID,
      p_reason: 'chuyển kho',
    });
    expect(result.toStock.qty).toBe(6);
  });

  it('maps insufficient transfer stock to a bad request', async () => {
    const client = {
      from() {
        throw new Error('from should not be called');
      },
      rpc: async () => ({
        data: null,
        error: {
          hint: 'insufficient_stock',
          message: 'insufficient stock for transfer',
        },
      }),
    } as unknown as SupabaseLike;

    const service = new WarehousesService(client);
    await expect(
      service.transferStock(ORG_ID, {
        fromWarehouseId: FROM_WAREHOUSE_ID,
        toWarehouseId: TO_WAREHOUSE_ID,
        variantId: VARIANT_ID,
        qty: 99,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
