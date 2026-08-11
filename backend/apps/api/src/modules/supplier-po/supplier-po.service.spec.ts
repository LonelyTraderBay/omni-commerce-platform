import { describe, expect, it, vi } from 'vitest';

import { SupplierPoService, type SupabaseLike } from './supplier-po.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PO_ID = '22222222-2222-2222-2222-222222222222';
const WAREHOUSE_ID = '33333333-3333-3333-3333-333333333333';
const SUPPLIER_ID = '44444444-4444-4444-4444-444444444444';
const VARIANT_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '66666666-6666-6666-6666-666666666666';
const CREATED_AT = '2026-07-27T20:00:00.000Z';

describe('SupplierPoService', () => {
  it('receives a purchase order through the stock inbound RPC', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        purchaseOrderId: PO_ID,
        warehouseId: WAREHOUSE_ID,
        status: 'received',
        receivedAt: CREATED_AT,
        movements: [],
      },
      error: null,
    }));
    const client = {
      rpc,
      from(table: string) {
        expect(table).toBe('purchase_orders');
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        data: purchaseOrderRow(),
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
    } as unknown as SupabaseLike;

    const service = new SupplierPoService(client);
    const result = await service.receivePurchaseOrder(
      ORG_ID,
      PO_ID,
      { warehouseId: WAREHOUSE_ID },
      USER_ID,
    );

    expect(rpc).toHaveBeenCalledWith('receive_po', {
      p_org_id: ORG_ID,
      p_purchase_order_id: PO_ID,
      p_warehouse_id: WAREHOUSE_ID,
      p_actor_user_id: USER_ID,
    });
    expect(result.purchaseOrder.status).toBe('received');
    expect(result.purchaseOrder.items[0]).toMatchObject({
      variantId: VARIANT_ID,
      unitCostVnd: '42000',
    });
  });
});

function purchaseOrderRow() {
  return {
    id: PO_ID,
    org_id: ORG_ID,
    supplier_id: SUPPLIER_ID,
    warehouse_id: WAREHOUSE_ID,
    status: 'received',
    note: null,
    ordered_at: CREATED_AT,
    received_at: CREATED_AT,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    supplier: {
      id: SUPPLIER_ID,
      org_id: ORG_ID,
      name: 'Supplier A',
      tax_code: null,
      email: null,
      phone: null,
      address_text: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    items: [
      {
        id: '77777777-7777-7777-7777-777777777777',
        org_id: ORG_ID,
        purchase_order_id: PO_ID,
        variant_id: VARIANT_ID,
        qty: 3,
        unit_cost_vnd: '42000',
        created_at: CREATED_AT,
      },
    ],
  };
}
