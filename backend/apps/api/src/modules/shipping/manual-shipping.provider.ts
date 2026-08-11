import type {
  CreateShipmentInput,
  CreateShipmentResult,
  ShippingProvider,
} from './shipping-provider';

export class ManualShippingProvider implements ShippingProvider {
  async createShipment(
    input: CreateShipmentInput,
  ): Promise<CreateShipmentResult> {
    const trackingCode = `MANUAL-${input.order.id.slice(0, 8).toUpperCase()}`;
    const feeVnd = readFeeVnd(input.connection.config);

    return {
      externalShipmentId: trackingCode,
      trackingCode,
      status: 'created',
      feeVnd,
      labelUrl: null,
      raw: {
        mode: 'manual',
        orderId: input.order.id,
        feeVnd: feeVnd.toString(),
      },
    };
  }
}

function readFeeVnd(config: Record<string, unknown>) {
  const value =
    config.feeVnd ?? config.manualFeeVnd ?? config.defaultFeeVnd ?? 0;

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return 0n;
    }
    return BigInt(value);
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }

  return 0n;
}
