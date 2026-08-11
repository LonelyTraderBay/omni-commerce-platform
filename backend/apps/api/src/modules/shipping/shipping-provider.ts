export type ShippingProviderCode = 'manual' | 'ghn';
export type ShipmentStatus =
  | 'created'
  | 'picking'
  | 'delivering'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export type ShippingOrderItem = {
  id: string;
  productId: string;
  variantId: string;
  titleSnapshot: string;
  skuSnapshot: string;
  qty: number;
  unitPriceVnd: string;
  lineTotalVnd: string;
};

export type ShippingOrder = {
  id: string;
  customerName: string | null;
  phoneE164: string | null;
  addressText: string | null;
  addressJson: Record<string, unknown>;
  items: ShippingOrderItem[];
};

export type ShippingConnection = {
  id: string | null;
  provider: ShippingProviderCode;
  displayName: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
};

export type CreateShipmentInput = {
  orgId: string;
  order: ShippingOrder;
  connection: ShippingConnection;
};

export type CreateShipmentResult = {
  externalShipmentId: string | null;
  trackingCode: string | null;
  status: ShipmentStatus;
  feeVnd: bigint;
  labelUrl: string | null;
  raw: Record<string, unknown>;
  /**
   * True when no carrier was actually contacted and the identifiers are
   * fabricated (dev/demo only). Callers MUST NOT let a mock result touch money
   * or order state: no shipping fee write, no `ship_order`, no COD expectation.
   */
  isMock?: boolean;
};

export interface ShippingProvider {
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  getTracking?(trackingCode: string): Promise<Record<string, unknown>>;
}
