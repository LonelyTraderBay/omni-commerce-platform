import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { OrdersController } from './orders.controller';
import { type OrdersService } from './orders.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const VARIANT_ID = '77777777-7777-7777-7777-777777777777';

describe('OrdersController createDraftOrder', () => {
  it('rejects POST /v1/orders when Idempotency-Key is missing', () => {
    const service = {
      createDraftOrder: vi.fn(),
    } as unknown as OrdersService;
    const controller = new OrdersController(service);

    let thrown: unknown;
    try {
      controller.createDraftOrder(
        ORG_ID,
        { id: USER_ID },
        { originalUrl: '/v1/orders' } as never,
        {
          paymentMethod: 'cod',
          addressJson: {},
          items: [{ variantId: VARIANT_ID, qty: 1 }],
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      response: expect.objectContaining({
        code: 'missing_idempotency_key',
      }),
      status: 400,
    });
    expect(service.createDraftOrder).not.toHaveBeenCalled();
  });
});

describe('OrdersController markOrderDone', () => {
  it('delegates POST /v1/orders/:orderId/done to the service with the caller identity', async () => {
    const service = {
      markOrderDone: vi.fn(async () => ({
        order: { id: ORDER_ID, status: 'done' },
      })),
    } as unknown as OrdersService;
    const controller = new OrdersController(service);

    const result = await controller.markOrderDone(
      ORG_ID,
      { id: USER_ID },
      ORDER_ID,
    );

    expect(service.markOrderDone).toHaveBeenCalledWith({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      actorUserId: USER_ID,
    });
    expect(result).toEqual({ order: { id: ORDER_ID, status: 'done' } });
  });

  it('requires orders.write, matching confirm/cancel/ship/return', () => {
    const permission = Reflect.getMetadata(
      PERMISSION_KEY,
      OrdersController.prototype.markOrderDone,
    );

    expect(permission).toBe('orders.write');
    expect(permission).toBe(
      Reflect.getMetadata(PERMISSION_KEY, OrdersController.prototype.shipOrder),
    );
    expect(permission).toBe(
      Reflect.getMetadata(
        PERMISSION_KEY,
        OrdersController.prototype.returnOrder,
      ),
    );
  });
});
