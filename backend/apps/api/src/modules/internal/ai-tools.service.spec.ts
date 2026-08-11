import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AiToolsService, type SupabaseLike } from './ai-tools.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const VARIANT_ID = '33333333-3333-3333-3333-333333333333';

type SupabaseCall = {
  op: string;
  table?: string;
  fn?: string;
  args?: unknown;
  values?: string;
  field?: string;
  value?: unknown;
};

function mockSupabaseForDraftMax(input: { maxVnd: number | string }) {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(values: string) {
          calls.push({ op: 'select', table, values });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: 'eq', table, field, value });
              return query;
            },
            is(field: string, value: unknown) {
              calls.push({ op: 'is', table, field, value });
              return query;
            },
            maybeSingle: async () => {
              if (table === 'organizations') {
                return {
                  data: {
                    id: ORG_ID,
                    settings_json: {
                      aiDraftMaxAmountVnd: input.maxVnd,
                    },
                  },
                  error: null,
                };
              }

              if (table === 'product_variants') {
                return {
                  data: {
                    id: VARIANT_ID,
                    org_id: ORG_ID,
                    product_id: PRODUCT_ID,
                    sku: 'TSHIRT-BLACK-M',
                    title: 'Black T-shirt / M',
                    price_vnd: '750',
                    stock_qty: 10,
                    attrs_json: {},
                    created_at: '2026-07-24T00:00:00.000Z',
                    updated_at: '2026-07-24T00:00:00.000Z',
                  },
                  error: null,
                };
              }

              if (table === 'products') {
                return {
                  data: { id: PRODUCT_ID },
                  error: null,
                };
              }

              return { data: null, error: null };
            },
          };
          return query;
        },
      };
    },
    rpc(fn: string, args: unknown) {
      calls.push({ op: 'rpc', fn, args });
      return {
        data: {
          order: { id: '44444444-4444-4444-4444-444444444444' },
          items: [],
        },
        error: null,
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

describe('AiToolsService', () => {
  it('rejects create-draft-order when resolved total exceeds the org draft max', async () => {
    const { calls, client } = mockSupabaseForDraftMax({ maxVnd: 1_000 });
    const service = new AiToolsService(client);

    await expect(
      service.createDraftOrder({
        orgId: ORG_ID,
        paymentMethod: 'cod',
        customerName: 'Nguyen Van A',
        phoneE164: '+84901234567',
        addressText: '1 Le Loi, Q1, HCMC',
        addressJson: {},
        items: [{ variantId: VARIANT_ID, qty: 2 }],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(calls).toContainEqual({
      op: 'select',
      table: 'organizations',
      values: 'id, settings_json',
    });
    expect(calls).toContainEqual({
      op: 'select',
      table: 'product_variants',
      values:
        'id, org_id, product_id, sku, title, price_vnd, stock_qty, attrs_json, created_at, updated_at',
    });
    expect(calls).not.toContainEqual(expect.objectContaining({ op: 'rpc' }));
  });

  it('passes optional attribution fields to the draft-order RPC', async () => {
    const { calls, client } = mockSupabaseForDraftMax({ maxVnd: 10_000 });
    const service = new AiToolsService(client);

    await service.createDraftOrder({
      orgId: ORG_ID,
      paymentMethod: 'cod',
      customerName: 'Nguyen Van A',
      phoneE164: '+84901234567',
      addressText: '1 Le Loi, Q1, HCMC',
      addressJson: {},
      idempotencyKey: 'ai-draft-1',
      utmSource: 'facebook',
      utmMedium: 'paid_social',
      utmCampaign: 'launch',
      clickId: 'fbclid-ai',
      items: [{ variantId: VARIANT_ID, qty: 2 }],
    });

    expect(calls).toContainEqual({
      op: 'rpc',
      fn: 'create_draft_order',
      args: expect.objectContaining({
        p_idempotency_key: 'ai-draft-1',
        p_utm_source: 'facebook',
        p_utm_medium: 'paid_social',
        p_utm_campaign: 'launch',
        p_click_id: 'fbclid-ai',
      }),
    });
  });
});
