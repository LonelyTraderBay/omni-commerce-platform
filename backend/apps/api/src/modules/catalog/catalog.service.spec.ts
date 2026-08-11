import { InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  CatalogService,
  type OutboxEnqueuer,
  type SupabaseLike,
} from './catalog.service';
import { CreateProductBodySchema } from './dto';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const VARIANT_ID = '33333333-3333-3333-3333-333333333333';
const OUTBOX_ID = '44444444-4444-4444-4444-444444444444';
const CREATED_AT = '2026-07-24T10:00:00.000Z';

function productRow() {
  return {
    id: PRODUCT_ID,
    org_id: ORG_ID,
    title: 'T-shirt',
    description: 'Cotton',
    status: 'active',
    attrs_json: { color: 'black' },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    deleted_at: null,
  };
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VARIANT_ID,
    org_id: ORG_ID,
    product_id: PRODUCT_ID,
    sku: 'AT-DEN-L',
    title: 'Black / L',
    price_vnd: '1234567890123',
    stock_qty: 7,
    cogs_vnd: '456000',
    attrs_json: { size: 'L' },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function catalogSupabaseMock() {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const client = {
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return {
        single: async () => ({
          data: {
            product: productRow(),
            variants: [variantRow()],
            outbox_event_id: OUTBOX_ID,
          },
          error: null,
        }),
      };
    },
    from(table: string) {
      if (table === 'products') {
        return {
          update() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      is() {
                        return {
                          select() {
                            return {
                              maybeSingle: async () => ({
                                data: productRow(),
                                error: null,
                              }),
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseLike;

  return { client, rpcCalls };
}

describe('CatalogService', () => {
  it('creates a product atomically via RPC with variants and outbox', async () => {
    const { client, rpcCalls } = catalogSupabaseMock();
    const enqueue = vi.fn(async () => ({ id: OUTBOX_ID })) as OutboxEnqueuer;
    const service = new CatalogService(client, enqueue);

    const result = await service.createProduct(
      ORG_ID,
      CreateProductBodySchema.parse({
        title: 'T-shirt',
        description: 'Cotton',
        attrs: { color: 'black' },
        variants: [
          {
            sku: 'AT-DEN-L',
            title: 'Black / L',
            priceVnd: '1234567890123',
            stockQty: 7,
            cogsVnd: '456000',
            attrs: { size: 'L' },
          },
        ],
      }),
    );

    expect(rpcCalls).toEqual([
      {
        fn: 'create_product_with_variants_and_reindex',
        args: {
          p_org_id: ORG_ID,
          p_title: 'T-shirt',
          p_description: 'Cotton',
          p_status: 'active',
          p_attrs_json: { color: 'black' },
          p_variants: [
            {
              sku: 'AT-DEN-L',
              title: 'Black / L',
              price_vnd: '1234567890123',
              stock_qty: 7,
              cogs_vnd: '456000',
              attrs_json: { size: 'L' },
            },
          ],
        },
      },
    ]);
    expect(result.product.variants).toEqual([
      expect.objectContaining({
        id: VARIANT_ID,
        priceVnd: '1234567890123',
        cogsVnd: '456000',
      }),
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propagates outbox enqueue failures on product update', async () => {
    const { client } = catalogSupabaseMock();
    const enqueue = vi.fn(async () => {
      throw new InternalServerErrorException({
        code: 'outbox_failed',
        message: 'Could not enqueue outbox event',
      });
    }) as OutboxEnqueuer;
    const service = new CatalogService(client, enqueue);

    await expect(
      service.updateProduct(ORG_ID, PRODUCT_ID, { title: 'Updated' }),
    ).rejects.toMatchObject({
      response: { code: 'outbox_failed' },
    });
    expect(enqueue).toHaveBeenCalledWith(client, {
      orgId: ORG_ID,
      eventName: 'knowledge.reindex',
      payload: {
        orgId: ORG_ID,
        sourceType: 'product',
        sourceId: PRODUCT_ID,
      },
    });
  });
});
