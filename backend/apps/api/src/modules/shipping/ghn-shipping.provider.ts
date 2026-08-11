import { BadRequestException } from '@nestjs/common';

import type {
  CreateShipmentInput,
  CreateShipmentResult,
  ShippingProvider,
} from './shipping-provider';

export type FetchLike = (
  input: string,
  init?: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class GhnShippingProvider implements ShippingProvider {
  constructor(private readonly fetchImpl?: FetchLike) {}

  async createShipment(
    input: CreateShipmentInput,
  ): Promise<CreateShipmentResult> {
    const token = readString(input.connection.credentials.token);
    if (!token) {
      throw new BadRequestException({
        code: 'carrier_not_configured',
        message: 'GHN token is required before creating shipments',
      });
    }

    const sandboxUrl = readString(input.connection.config.sandboxUrl);
    const request = buildSandboxRequest(input);
    if (sandboxUrl) {
      return this.createSandboxShipment(sandboxUrl, token, request);
    }

    // Fail closed. Without a carrier endpoint we cannot know the tracking code
    // or the fee, and fabricating them used to flow straight into
    // `orders.shipping_fee_vnd = 0`, `ship_order`, and a COD expectation —
    // money and fulfilment state derived from a shipment that never existed.
    // Mock stays available for dev/demo, but only when the org opts in.
    if (input.connection.config.allowMock !== true) {
      throw new BadRequestException({
        code: 'carrier_not_configured',
        message:
          'GHN requires config.sandboxUrl. Set it, or enable config.allowMock for non-production use.',
      });
    }

    const suffix = input.order.id.slice(0, 8).toUpperCase();
    return {
      externalShipmentId: `GHN-MOCK-${suffix}`,
      trackingCode: `GHN-MOCK-${suffix}`,
      status: 'created',
      feeVnd: 0n,
      labelUrl: null,
      isMock: true,
      raw: {
        mode: 'mock',
        provider: 'ghn',
        warning:
          'No carrier was contacted. Identifiers are fabricated and the fee is unknown, not zero.',
        request,
      },
    };
  }

  private async createSandboxShipment(
    sandboxUrl: string,
    token: string,
    request: Record<string, unknown>,
  ) {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new BadRequestException({
        code: 'carrier_not_configured',
        message: 'GHN sandbox fetch is not available',
      });
    }

    try {
      const response = await fetchImpl(sandboxUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Token: token,
        },
        body: JSON.stringify(request),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new BadRequestException({
          code: 'carrier_request_failed',
          message: `GHN sandbox returned HTTP ${response.status}`,
        });
      }

      const data = asRecord(body.data) ?? body;
      const orderCode =
        readString(data.order_code) ??
        readString(data.externalShipmentId) ??
        `GHN-SANDBOX-${request.orderId}`;
      const feeVnd = readBigintVnd(data.total_fee ?? data.feeVnd);

      return {
        externalShipmentId: orderCode,
        trackingCode: readString(data.tracking_code) ?? orderCode,
        status: 'created',
        feeVnd,
        labelUrl: readString(data.label_url),
        raw: {
          mode: 'sandbox',
          request,
          response: body,
        },
      } satisfies CreateShipmentResult;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        code: 'carrier_request_failed',
        message: 'Could not create GHN sandbox shipment',
      });
    }
  }
}

function buildSandboxRequest(input: CreateShipmentInput) {
  return {
    orderId: input.order.id,
    customerName: input.order.customerName,
    phoneE164: input.order.phoneE164,
    addressText: input.order.addressText,
    addressJson: input.order.addressJson,
    shopId: input.connection.credentials.shopId ?? null,
    items: input.order.items.map((item) => ({
      sku: item.skuSnapshot,
      name: item.titleSnapshot,
      quantity: item.qty,
      unitPriceVnd: item.unitPriceVnd,
    })),
  };
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBigintVnd(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return 0n;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
