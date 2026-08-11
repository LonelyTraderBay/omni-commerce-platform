import { buildApiHeaders, getActiveOrgId } from './org-context';
import {
  getAccessToken,
  type OrganizationRole,
  type StoredOrganization,
} from './auth-session';

export type ChannelConnection = {
  id: string;
  provider: string;
  externalPageId: string;
  status: 'active' | 'needs_reauth' | 'revoked' | string;
  createdAt: string;
};

export type InboxConversation = {
  id: string;
  channel: 'messenger' | 'instagram' | 'zalo' | string;
  status: string;
  botPaused: boolean;
  botEpoch: number;
  assigneeUserId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  contact?: {
    id: string;
    displayName: string | null;
    pageScopedId: string | null;
    igScopedId: string | null;
  };
  channelConnection?: {
    id: string;
    provider: string;
    externalPageId: string;
    externalIgId: string | null;
  };
};

export type InboxMessage = {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound' | string;
  senderType: 'customer' | 'ai' | 'staff' | 'system' | string;
  rawType: string;
  bodyText: string | null;
  providerMessageId: string | null;
  createdAt: string;
};

export type ProductStatus = 'active' | 'archived';

export type CatalogProduct = {
  id: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  attrs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  variants?: CatalogVariant[];
};

export type CatalogVariant = {
  id: string;
  productId: string;
  sku: string;
  title: string;
  priceVnd: string;
  stockQty: number;
  cogsVnd: string;
  attrs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type Warehouse = {
  id: string;
  orgId: string;
  name: string;
  code: string;
  isDefault: boolean;
  createdAt: string;
};

export type WarehouseStock = {
  orgId: string;
  warehouseId: string;
  variantId: string;
  qty: number;
  variant: CatalogVariant | null;
};

export type Supplier = {
  id: string;
  orgId: string;
  name: string;
  taxCode: string | null;
  email: string | null;
  phone: string | null;
  addressText: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PurchaseOrderStatus =
  | 'draft'
  | 'ordered'
  | 'received'
  | 'cancelled';

export type PurchaseOrderItem = {
  id: string;
  orgId: string;
  purchaseOrderId: string;
  variantId: string;
  qty: number;
  unitCostVnd: string;
  createdAt: string;
};

export type PurchaseOrder = {
  id: string;
  orgId: string;
  supplierId: string;
  warehouseId: string | null;
  status: PurchaseOrderStatus;
  note: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  supplier: Supplier | null;
  items: PurchaseOrderItem[];
};

export type ProductInput = {
  title: string;
  description?: string | null;
  status?: ProductStatus;
  attrs?: Record<string, unknown>;
  variants?: VariantInput[];
};

export type VariantInput = {
  sku: string;
  title: string;
  priceVnd: string;
  stockQty: number;
  cogsVnd?: string;
  attrs?: Record<string, unknown>;
};

export type OrderStatus =
  'draft' | 'confirmed' | 'shipped' | 'done' | 'cancelled' | 'returned';

export type Order = {
  id: string;
  conversationId: string | null;
  contactId: string | null;
  status: OrderStatus;
  paymentMethod: 'cod' | 'bank_transfer' | 'other' | string;
  customerName: string | null;
  phoneE164: string | null;
  addressText: string | null;
  addressJson: Record<string, unknown>;
  currency: 'VND' | string;
  subtotalVnd: string;
  shippingFeeVnd?: string;
  totalVnd: string;
  idempotencyKey: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  clickId: string | null;
  confirmedAt: string | null;
  shippedAt: string | null;
  cancelledAt: string | null;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  items?: OrderItem[];
};

export type ShippingProvider = 'manual' | 'ghn';

export type CarrierConnection = {
  id: string;
  provider: ShippingProvider;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Shipment = {
  id: string;
  orgId: string;
  orderId: string;
  carrierConnectionId: string | null;
  provider: ShippingProvider;
  externalShipmentId: string | null;
  trackingCode: string | null;
  status: string;
  feeVnd: string;
  labelUrl: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CodExpectation = {
  id: string;
  orgId: string;
  orderId: string;
  expectedVnd: string;
  collectedVnd: string;
  deltaVnd: string;
  status: 'open' | 'matched' | 'discrepancy' | 'written_off' | string;
  createdAt: string;
  order: {
    id: string;
    status: OrderStatus | string;
    paymentMethod: string;
    customerName: string | null;
    phoneE164: string | null;
    totalVnd: string;
    shippedAt: string | null;
    createdAt: string;
  } | null;
};

export type CodCollection = {
  id: string;
  orgId: string;
  orderId: string;
  amountVnd: string;
  collectedAt: string;
  source: 'manual' | 'carrier_file' | 'carrier_api' | string;
  note: string | null;
  createdAt: string;
};

export type CodDiscrepancy = {
  id: string;
  orgId: string;
  orderId: string;
  expectedVnd: string;
  collectedVnd: string;
  deltaVnd: string;
  status: 'open' | 'resolved' | string;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type CodReport = {
  summary: {
    openCount: number;
    discrepancyCount: number;
    expectedVnd: string;
    collectedVnd: string;
    deltaVnd: string;
  };
  expectations: CodExpectation[];
  /** True when more open/discrepant expectations exist than `expectations`
   * returned (capped at the newest 100); `summary` stays complete either way. */
  expectationsTruncated: boolean;
  discrepancies: CodDiscrepancy[];
  /** True when more open discrepancies exist than `discrepancies` returned
   * (capped at the newest 100); `summary.discrepancyCount` stays complete
   * either way. */
  discrepanciesTruncated: boolean;
};

export type OrderItem = {
  id: string;
  productId: string;
  variantId: string;
  titleSnapshot: string;
  skuSnapshot: string;
  qty: number;
  unitPriceVnd: string;
  lineTotalVnd: string;
  cogsUnitVnd?: string;
};

export type PnlDay = {
  day: string;
  revenueVnd: string;
  cogsVnd: string;
  grossProfitVnd: string;
  shippingVnd: string;
  adSpendVnd: string;
  netProfitVnd: string;
  orderCount: number;
};

export type PnlSummary = {
  revenueVnd: string;
  cogsVnd: string;
  grossProfitVnd: string;
  shippingVnd: string;
  adSpendVnd: string;
  /** grossProfitVnd − shippingVnd − adSpendVnd. */
  netProfitVnd: string;
  orderCount: number;
  days: PnlDay[];
};

export type PnlSku = {
  sku: string;
  qty: number;
  revenueVnd: string;
  cogsVnd: string;
  grossProfitVnd: string;
  orderCount: number;
};

export type BillingEntitlements = {
  orgId: string;
  maxPages: number;
  aiMonthlyTokenLimit: number;
  autoConfirmAllowed: boolean;
  autoConfirmBlockedReason?: string | null;
  updatedAt: string;
};

export type BillingPlan = {
  plan: string;
  billingStatus: 'active' | 'past_due' | 'suspended' | string;
  billingCustomerEmail: string | null;
  planRenewsAt: string | null;
  entitlements: BillingEntitlements;
  dunning?: {
    autoConfirmBlocked: boolean;
    reason: string | null;
  };
};

export type BillingUsage = {
  periodStart: string;
  pagesConnectedCount: number;
  aiTokensMonth: number;
  ordersCountMonth: number;
};

export type BillingInvoice = {
  id: string;
  orgId: string;
  periodStart: string;
  periodEnd: string;
  amountVnd: string;
  status: 'draft' | 'issued' | 'paid' | 'void' | string;
  issuedAt: string | null;
  note: string | null;
  createdAt: string;
};

export type AdSpendSource = 'meta_ads' | 'csv';

export type AdSpendRecord = {
  id: string;
  orgId: string;
  source: AdSpendSource | string;
  date: string;
  campaignName: string;
  amountVnd: string;
  externalId: string | null;
  createdAt: string;
};

export type AdSpendDay = {
  day: string;
  amountVnd: string;
};

export type AdSpendSummary = {
  totalVnd: string;
  days: AdSpendDay[];
};

export type AttributionSourceSummary = {
  utmSource: string | null;
  label: string;
  orderCount: number;
  revenueVnd: string;
};

export type AttributionSummary = {
  totalOrders: number;
  totalRevenueVnd: string;
  sources: AttributionSourceSummary[];
};

export type AdvisorSuggestion = {
  suggestionsText: string;
  disclaimer: string;
  promptVersion: string;
  model: string;
  citations: Array<Record<string, unknown>>;
  entitlement: {
    allowed: boolean;
    note: string;
  };
};

export type ContentCalendarStatus =
  | 'idea'
  | 'scheduled'
  | 'posted'
  | 'cancelled';

export type ContentCalendarItem = {
  id: string;
  orgId: string;
  title: string;
  body: string | null;
  plannedAt: string;
  status: ContentCalendarStatus;
  channelHint: string | null;
  autoPostEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContentCalendarInput = {
  title: string;
  body?: string | null;
  plannedAt: string;
  status?: ContentCalendarStatus;
  channelHint?: string | null;
  autoPostEnabled?: boolean;
};

export type OrdersExportFormat = 'csv' | 'xlsx' | 'pdf';

export type EinvoiceJobStatus = 'pending' | 'sent' | 'failed' | 'dead';

export type EinvoiceProvider = 'stub' | 'http_sandbox';

export type EinvoiceJob = {
  id: string;
  orgId: string;
  orderId: string;
  provider: EinvoiceProvider | string;
  status: EinvoiceJobStatus | string;
  attempts: number;
  lastError: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};

export type ApiAuthContext = {
  accessToken: string;
  orgId: string;
};

export type OrganizationMembership = {
  organization: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    settingsJson?: Record<string, unknown>;
    timezone: string;
    locale: string;
    suspendedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  membership: {
    id: string;
    orgId: string;
    userId: string;
    role: OrganizationRole;
  };
};

export type MembershipInvite = {
  id: string;
  orgId: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string | null;
};

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:4701';
}

/**
 * Parses an API error response body into `{ code, message }`.
 *
 * The API's global error handler (backend/apps/api/src/common/filters/problem-details.filter.ts)
 * returns RFC 7807 Problem Details: `{ type, title, status, detail, instance,
 * requestId, code? }`. The human-readable text lives in `detail` (falling
 * back to `title`) — there is no top-level `message` field in that shape.
 * Some older/simpler error bodies may still use `{ code, message }` (or a
 * Nest validation-pipe body with a `message` string/array), so both shapes
 * are supported to avoid ever losing a real error message.
 */
async function parseApiErrorBody(
  response: Response,
): Promise<{ code: string; message: string | undefined }> {
  let code = 'api_error';
  let message: string | undefined;

  try {
    const body = (await response.json()) as {
      code?: string;
      detail?: string;
      title?: string;
      message?: string | string[];
    };

    if (body.code) {
      code = body.code;
    }

    if (typeof body.detail === 'string' && body.detail) {
      message = body.detail;
    } else if (Array.isArray(body.message) && body.message.length > 0) {
      message = body.message.join(', ');
    } else if (typeof body.message === 'string' && body.message) {
      message = body.message;
    } else if (typeof body.title === 'string' && body.title) {
      message = body.title;
    }
  } catch {
    // Ignore non-JSON error bodies.
  }

  return { code, message };
}

export function getApiAuthContext(): ApiAuthContext | null {
  const accessToken = getAccessToken();
  const orgId = getActiveOrgId();

  if (!accessToken || !orgId) {
    return null;
  }

  return { accessToken, orgId };
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  options: {
    requireOrg?: boolean;
    accessToken?: string;
  } = {},
): Promise<T> {
  const accessToken = options.accessToken ?? getAccessToken();
  if (!accessToken) {
    throw new ApiClientError('missing_auth', 'Thiếu phiên đăng nhập.');
  }

  const requireOrg = options.requireOrg ?? true;
  const orgId = getActiveOrgId();
  if (requireOrg && !orgId) {
    throw new ApiClientError('missing_auth', 'Thiếu tổ chức đang chọn.');
  }

  const headers = new Headers(init.headers);
  const defaultHeaders = requireOrg
    ? buildApiHeaders({ accessToken, orgId: orgId as string })
    : {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      };

  for (const [key, value] of Object.entries(defaultHeaders)) {
    headers.set(key, headers.get(key) ?? value);
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const { code, message } = await parseApiErrorBody(response);
    throw new ApiClientError(
      code,
      message ?? `Yêu cầu API thất bại (${response.status})`,
      response.status,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function listChannels(): Promise<ChannelConnection[]> {
  return apiFetch<ChannelConnection[]>('/v1/channels');
}

export async function listInboxConversations(): Promise<InboxConversation[]> {
  const { conversations } = await apiFetch<{
    conversations: InboxConversation[];
  }>('/v1/inbox/conversations');

  return conversations;
}

export async function listInboxMessages(
  conversationId: string,
): Promise<InboxMessage[]> {
  const { messages } = await apiFetch<{ messages: InboxMessage[] }>(
    `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
  );

  return messages;
}

export async function listProducts(): Promise<CatalogProduct[]> {
  const { products } = await apiFetch<{ products: CatalogProduct[] }>(
    '/v1/catalog/products',
  );

  return products;
}

export async function getProduct(productId: string): Promise<CatalogProduct> {
  const { product } = await apiFetch<{ product: CatalogProduct }>(
    `/v1/catalog/products/${encodeURIComponent(productId)}`,
  );

  return product;
}

export async function createProduct(
  input: ProductInput,
): Promise<CatalogProduct> {
  const { product } = await apiFetch<{ product: CatalogProduct }>(
    '/v1/catalog/products',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );

  return product;
}

export async function updateProduct(
  productId: string,
  input: ProductInput,
): Promise<CatalogProduct> {
  const { product } = await apiFetch<{ product: CatalogProduct }>(
    `/v1/catalog/products/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );

  return product;
}

export async function deleteProduct(
  productId: string,
): Promise<CatalogProduct> {
  const { product } = await apiFetch<{ product: CatalogProduct }>(
    `/v1/catalog/products/${encodeURIComponent(productId)}`,
    { method: 'DELETE' },
  );

  return product;
}

export async function createVariant(
  productId: string,
  input: VariantInput,
): Promise<CatalogVariant> {
  const { variant } = await apiFetch<{ variant: CatalogVariant }>(
    `/v1/catalog/products/${encodeURIComponent(productId)}/variants`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );

  return variant;
}

export async function updateVariant(
  productId: string,
  variantId: string,
  input: VariantInput,
): Promise<CatalogVariant> {
  const { variant } = await apiFetch<{ variant: CatalogVariant }>(
    `/v1/catalog/products/${encodeURIComponent(
      productId,
    )}/variants/${encodeURIComponent(variantId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );

  return variant;
}

export async function deleteVariant(
  productId: string,
  variantId: string,
): Promise<CatalogVariant> {
  const { variant } = await apiFetch<{ variant: CatalogVariant }>(
    `/v1/catalog/products/${encodeURIComponent(
      productId,
    )}/variants/${encodeURIComponent(variantId)}`,
    { method: 'DELETE' },
  );

  return variant;
}

export type StockMovement = {
  id: string;
  orgId: string;
  warehouseId: string | null;
  variantId: string;
  movementType: string;
  qtyDelta: number;
  stockAfter: number;
  orderId: string | null;
  reason: string | null;
  actorUserId: string | null;
  createdAt: string;
};

export async function listStockMovements(input?: {
  variantId?: string;
  limit?: number;
}): Promise<StockMovement[]> {
  const params = new URLSearchParams();
  if (input?.variantId) {
    params.set('variantId', input.variantId);
  }
  if (input?.limit) {
    params.set('limit', String(input.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const { movements } = await apiFetch<{ movements: StockMovement[] }>(
    `/v1/inventory/movements${query}`,
  );
  return movements;
}

export async function listLowStock(threshold?: number): Promise<{
  threshold: number;
  variants: CatalogVariant[];
}> {
  const query =
    threshold === undefined
      ? ''
      : `?threshold=${encodeURIComponent(String(threshold))}`;
  return apiFetch<{ threshold: number; variants: CatalogVariant[] }>(
    `/v1/inventory/low-stock${query}`,
  );
}

export async function adjustStock(input: {
  variantId: string;
  qtyDelta: number;
  reason?: string;
  movementType?: 'adjust' | 'inbound' | 'outbound';
}): Promise<{ variant: CatalogVariant; movement: StockMovement }> {
  return apiFetch<{ variant: CatalogVariant; movement: StockMovement }>(
    '/v1/inventory/adjust',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export async function listWarehouses(): Promise<Warehouse[]> {
  const { warehouses } = await apiFetch<{ warehouses: Warehouse[] }>(
    '/v1/warehouses',
  );
  return warehouses;
}

export async function createWarehouse(input: {
  name: string;
  code: string;
}): Promise<Warehouse> {
  const { warehouse } = await apiFetch<{ warehouse: Warehouse }>(
    '/v1/warehouses',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return warehouse;
}

export async function getWarehouseStock(warehouseId: string): Promise<{
  warehouse: Warehouse;
  stock: WarehouseStock[];
}> {
  return apiFetch<{ warehouse: Warehouse; stock: WarehouseStock[] }>(
    `/v1/warehouses/${encodeURIComponent(warehouseId)}/stock`,
  );
}

export async function transferWarehouseStock(input: {
  fromWarehouseId: string;
  toWarehouseId: string;
  variantId: string;
  qty: number;
  reason?: string;
}): Promise<{
  variant: CatalogVariant;
  fromStock: { warehouseId: string; variantId: string; qty: number };
  toStock: { warehouseId: string; variantId: string; qty: number };
  movements: StockMovement[];
}> {
  return apiFetch<{
    variant: CatalogVariant;
    fromStock: { warehouseId: string; variantId: string; qty: number };
    toStock: { warehouseId: string; variantId: string; qty: number };
    movements: StockMovement[];
  }>('/v1/warehouses/transfer', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listSuppliers(): Promise<Supplier[]> {
  const { suppliers } = await apiFetch<{ suppliers: Supplier[] }>('/v1/suppliers');
  return suppliers;
}

export async function createSupplier(input: {
  name: string;
  taxCode?: string;
  email?: string;
  phone?: string;
  addressText?: string;
}): Promise<Supplier> {
  const { supplier } = await apiFetch<{ supplier: Supplier }>('/v1/suppliers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return supplier;
}

export async function listPurchaseOrders(
  status?: PurchaseOrderStatus,
): Promise<PurchaseOrder[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const { purchaseOrders } = await apiFetch<{
    purchaseOrders: PurchaseOrder[];
  }>(`/v1/purchase-orders${query}`);
  return purchaseOrders;
}

export async function createPurchaseOrder(input: {
  supplierId: string;
  warehouseId?: string;
  status?: PurchaseOrderStatus;
  note?: string;
  items: Array<{ variantId: string; qty: number; unitCostVnd: string }>;
}): Promise<PurchaseOrder> {
  const { purchaseOrder } = await apiFetch<{ purchaseOrder: PurchaseOrder }>(
    '/v1/purchase-orders',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return purchaseOrder;
}

export async function updatePurchaseOrderStatus(
  purchaseOrderId: string,
  status: 'ordered' | 'cancelled',
): Promise<PurchaseOrder> {
  const { purchaseOrder } = await apiFetch<{ purchaseOrder: PurchaseOrder }>(
    `/v1/purchase-orders/${encodeURIComponent(purchaseOrderId)}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
  );
  return purchaseOrder;
}

export async function receivePurchaseOrder(input: {
  purchaseOrderId: string;
  warehouseId: string;
}): Promise<{ purchaseOrder: PurchaseOrder; receive: unknown }> {
  return apiFetch<{ purchaseOrder: PurchaseOrder; receive: unknown }>(
    `/v1/purchase-orders/${encodeURIComponent(input.purchaseOrderId)}/receive`,
    {
      method: 'POST',
      body: JSON.stringify({ warehouseId: input.warehouseId }),
    },
  );
}

export async function listOrders(status?: OrderStatus): Promise<Order[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const { orders } = await apiFetch<{ orders: Order[] }>(`/v1/orders${query}`);

  return orders;
}

export async function getOrder(orderId: string): Promise<Order> {
  const { order } = await apiFetch<{ order: Order }>(
    `/v1/orders/${encodeURIComponent(orderId)}`,
  );

  return order;
}

export async function confirmOrder(orderId: string): Promise<Order> {
  const { order } = await apiFetch<{ order: Order }>(
    `/v1/orders/${encodeURIComponent(orderId)}/confirm`,
    { method: 'POST' },
  );

  return order;
}

export async function cancelOrder(orderId: string): Promise<Order> {
  const { order } = await apiFetch<{ order: Order }>(
    `/v1/orders/${encodeURIComponent(orderId)}/cancel`,
    { method: 'POST' },
  );

  return order;
}

export async function shipOrder(orderId: string): Promise<Order> {
  const { order } = await apiFetch<{ order: Order }>(
    `/v1/orders/${encodeURIComponent(orderId)}/ship`,
    { method: 'POST' },
  );

  return order;
}

export async function returnOrder(
  orderId: string,
  input: { reason?: string; restock?: boolean } = {},
): Promise<Order> {
  const { order } = await apiFetch<{ order: Order }>(
    `/v1/orders/${encodeURIComponent(orderId)}/return`,
    {
      method: 'POST',
      body: JSON.stringify({
        restock: input.restock ?? true,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
  );

  return order;
}

export async function markOrderDone(orderId: string): Promise<Order> {
  const { order } = await apiFetch<{ order: Order }>(
    `/v1/orders/${encodeURIComponent(orderId)}/done`,
    { method: 'POST' },
  );

  return order;
}

export async function createShipment(input: {
  orderId: string;
  provider?: ShippingProvider;
  carrierConnectionId?: string;
}): Promise<{ shipment: Shipment; order?: Order; items?: OrderItem[] }> {
  return apiFetch<{ shipment: Shipment; order?: Order; items?: OrderItem[] }>(
    '/v1/shipping/shipments',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export async function listShipments(orderId: string): Promise<Shipment[]> {
  const { shipments } = await apiFetch<{ shipments: Shipment[] }>(
    `/v1/shipping/shipments?orderId=${encodeURIComponent(orderId)}`,
  );

  return shipments;
}

export async function getCodReport(): Promise<CodReport> {
  return apiFetch<CodReport>('/v1/cod/report');
}

export async function recordCodCollection(input: {
  orderId: string;
  amountVnd: string;
  note?: string;
}): Promise<CodCollection> {
  const { collection } = await apiFetch<{ collection: CodCollection }>(
    '/v1/cod/collections',
    {
      method: 'POST',
      body: JSON.stringify({
        orderId: input.orderId,
        amountVnd: input.amountVnd,
        source: 'manual',
        ...(input.note ? { note: input.note } : {}),
      }),
    },
  );

  return collection;
}

export async function reconcileCodOrder(orderId: string) {
  return apiFetch<{
    expectation: CodExpectation;
    discrepancy: CodDiscrepancy | null;
    summary: {
      expectedVnd: string;
      collectedVnd: string;
      deltaVnd: string;
    };
  }>('/v1/cod/reconcile', {
    method: 'POST',
    body: JSON.stringify({ orderId }),
  });
}

export async function reconcileCodBatch(orderIds?: string[]) {
  return apiFetch<{
    reconciled: number;
    results: unknown[];
    /** Reconcilable open/discrepancy COD expectations left after this call,
     * beyond the ones just reconciled. Always `0` when `orderIds` was named
     * explicitly. When `orderIds` is omitted (reconcile all open COD), at
     * most 100 are reconciled per call; call again with no `orderIds` to
     * continue until `remaining` is `0`. */
    remaining: number;
    /** True when `remaining` is greater than zero. */
    hasMore: boolean;
  }>('/v1/cod/reconcile/batch', {
    method: 'POST',
    body: JSON.stringify(orderIds ? { orderIds } : {}),
  });
}

export async function getPnlSummary(
  input: {
    from?: string;
    to?: string;
  } = {},
): Promise<PnlSummary> {
  return apiFetch<PnlSummary>(`/v1/pnl/summary${dateRangeQuery(input)}`);
}

export async function getPnlBySku(
  input: {
    from?: string;
    to?: string;
  } = {},
): Promise<PnlSku[]> {
  const { items } = await apiFetch<{ items: PnlSku[] }>(
    `/v1/pnl/by-sku${dateRangeQuery(input)}`,
  );
  return items;
}

export async function downloadAccountingExport(input: {
  from?: string;
  to?: string;
}): Promise<{ blob: Blob; filename: string }> {
  const response = await rawApiFetch(
    `/v1/accounting/export${dateRangeQuery({ ...input, format: 'csv' })}`,
  );
  const disposition = response.headers.get('content-disposition');
  return {
    blob: await response.blob(),
    filename:
      disposition?.match(/filename="([^"]+)"/i)?.[1] ?? 'accounting.csv',
  };
}

export async function importAdSpendCsv(csv: string): Promise<{
  importedCount: number;
  adSpend: AdSpendRecord[];
}> {
  return apiFetch<{ importedCount: number; adSpend: AdSpendRecord[] }>(
    '/v1/ad-spend/import',
    {
      method: 'POST',
      body: JSON.stringify({ csv, source: 'csv' }),
    },
  );
}

export async function listAdSpend(
  input: {
    from?: string;
    to?: string;
    limit?: number;
  } = {},
): Promise<AdSpendRecord[]> {
  const params = new URLSearchParams();
  if (input.from) {
    params.set('from', input.from);
  }
  if (input.to) {
    params.set('to', input.to);
  }
  if (input.limit) {
    params.set('limit', String(input.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const { adSpend } = await apiFetch<{ adSpend: AdSpendRecord[] }>(
    `/v1/ad-spend${query}`,
  );
  return adSpend;
}

export async function getAdSpendSummary(
  input: {
    from?: string;
    to?: string;
  } = {},
): Promise<AdSpendSummary> {
  return apiFetch<AdSpendSummary>(
    `/v1/ad-spend/summary${dateRangeQuery(input)}`,
  );
}

export async function getAttributionSummary(
  input: {
    from?: string;
    to?: string;
  } = {},
): Promise<AttributionSummary> {
  return apiFetch<AttributionSummary>(
    `/v1/attribution/summary${dateRangeQuery(input)}`,
  );
}

export async function getAdvisorSuggestion(
  input: {
    goal?: string;
  } = {},
): Promise<AdvisorSuggestion> {
  return apiFetch<AdvisorSuggestion>('/v1/advisor/suggest', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listContentCalendarItems(
  status?: ContentCalendarStatus,
): Promise<ContentCalendarItem[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const { items } = await apiFetch<{ items: ContentCalendarItem[] }>(
    `/v1/content-calendar${query}`,
  );
  return items;
}

export async function createContentCalendarItem(
  input: ContentCalendarInput,
): Promise<ContentCalendarItem> {
  const { item } = await apiFetch<{ item: ContentCalendarItem }>(
    '/v1/content-calendar',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return item;
}

export async function updateContentCalendarItem(
  itemId: string,
  input: Partial<ContentCalendarInput>,
): Promise<ContentCalendarItem> {
  const { item } = await apiFetch<{ item: ContentCalendarItem }>(
    `/v1/content-calendar/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
  return item;
}

export async function deleteContentCalendarItem(
  itemId: string,
): Promise<ContentCalendarItem> {
  const { item } = await apiFetch<{ item: ContentCalendarItem }>(
    `/v1/content-calendar/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
  return item;
}

export async function listEinvoiceJobs(status?: EinvoiceJobStatus): Promise<EinvoiceJob[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const { jobs } = await apiFetch<{ jobs: EinvoiceJob[] }>(
    `/v1/einvoice/jobs${query}`,
  );
  return jobs;
}

export async function issueEinvoice(
  orderId: string,
  provider?: EinvoiceProvider,
): Promise<EinvoiceJob> {
  const { job } = await apiFetch<{ job: EinvoiceJob }>('/v1/einvoice/issue', {
    method: 'POST',
    body: JSON.stringify(
      provider ? { orderId, provider } : { orderId },
    ),
  });
  return job;
}

export async function getBillingPlan(): Promise<BillingPlan> {
  return apiFetch<BillingPlan>('/v1/billing/plan');
}

export async function getBillingUsage(): Promise<BillingUsage> {
  return apiFetch<BillingUsage>('/v1/billing/usage');
}

export async function listBillingInvoices(): Promise<BillingInvoice[]> {
  const { invoices } = await apiFetch<{ invoices: BillingInvoice[] }>(
    '/v1/billing/invoices',
  );
  return invoices;
}

export async function downloadOrdersExport(input: {
  format: OrdersExportFormat;
  status?: OrderStatus;
}): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams({ format: input.format });
  if (input.status) {
    params.set('status', input.status);
  }

  const response = await rawApiFetch(`/v1/orders/export?${params.toString()}`);
  const disposition = response.headers.get('content-disposition');

  return {
    blob: await response.blob(),
    filename:
      disposition?.match(/filename="([^"]+)"/i)?.[1] ??
      `orders.${input.format}`,
  };
}

export async function takeoverInboxConversation(
  conversationId: string,
): Promise<InboxConversation> {
  const { conversation } = await apiFetch<{ conversation: InboxConversation }>(
    `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/takeover`,
    { method: 'POST' },
  );

  return conversation;
}

export async function resumeInboxConversation(
  conversationId: string,
): Promise<InboxConversation> {
  const { conversation } = await apiFetch<{ conversation: InboxConversation }>(
    `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/resume`,
    { method: 'POST' },
  );

  return conversation;
}

export async function sendInboxMessage(
  conversationId: string,
  text: string,
): Promise<InboxMessage> {
  const { message } = await apiFetch<{ message: InboxMessage }>(
    `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'POST', body: JSON.stringify({ text }) },
  );
  return message;
}

export async function listOrganizations(
  accessToken?: string,
): Promise<OrganizationMembership[]> {
  return apiFetch<OrganizationMembership[]>(
    '/v1/orgs',
    {},
    {
      accessToken,
      requireOrg: false,
    },
  );
}

export async function createOrganization(
  input: { name: string; slug: string },
  accessToken: string,
): Promise<OrganizationMembership> {
  return apiFetch<OrganizationMembership>('/v1/orgs', {
    method: 'POST',
    body: JSON.stringify(input),
  }, {
    accessToken,
    requireOrg: false,
  });
}

export async function updateOrgSettings(
  orgId: string,
  patch: Partial<{
    autoConfirm: boolean;
    aiReplies: boolean;
    aiDraftOrders: boolean;
    aiProductSuggestions: boolean;
  }>,
): Promise<OrganizationMembership['organization']> {
  const { organization } = await apiFetch<{
    organization: OrganizationMembership['organization'];
  }>(`/v1/orgs/${encodeURIComponent(orgId)}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return organization;
}

export function mapOrganizationMemberships(
  memberships: OrganizationMembership[],
): StoredOrganization[] {
  return memberships.map((membership) => ({
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    role: membership.membership.role,
  }));
}

export async function createInvite(input: {
  orgId: string;
  email: string;
  role: OrganizationRole;
}): Promise<{ invite: MembershipInvite; token: string }> {
  return apiFetch<{ invite: MembershipInvite; token: string }>(
    `/v1/orgs/${encodeURIComponent(input.orgId)}/invites`,
    {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        role: input.role,
      }),
    },
  );
}

export async function listInvites(orgId: string): Promise<{
  invites: MembershipInvite[];
}> {
  return apiFetch<{ invites: MembershipInvite[] }>(
    `/v1/orgs/${encodeURIComponent(orgId)}/invites`,
  );
}

export async function acceptInvite(token: string): Promise<{
  membership: {
    id: string;
    orgId: string;
    userId: string;
    role: OrganizationRole;
  };
  invite: MembershipInvite;
}> {
  return apiFetch(
    '/v1/invites/accept',
    {
      method: 'POST',
      body: JSON.stringify({ token }),
    },
    { requireOrg: false },
  );
}

export async function getMetaOAuthUrl(): Promise<{ url: string }> {
  return apiFetch<{ url: string }>('/v1/channels/meta/oauth-url');
}

export async function completeMetaOAuth(
  code: string,
  state: string,
): Promise<{ connections: ChannelConnection[] }> {
  return apiFetch<{ connections: ChannelConnection[] }>(
    '/v1/channels/meta/complete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    },
  );
}

export async function connectZalo(input: {
  oaId: string;
  accessToken: string;
  displayName?: string;
}): Promise<{ connection: ChannelConnection }> {
  return apiFetch<{ connection: ChannelConnection }>(
    '/v1/channels/zalo/connect',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function revokeChannel(
  channelId: string,
): Promise<{ connection: ChannelConnection }> {
  return apiFetch<{ connection: ChannelConnection }>(
    `/v1/channels/${encodeURIComponent(channelId)}/revoke`,
    { method: 'POST' },
  );
}

function dateRangeQuery(input: { from?: string; to?: string; format?: string }) {
  const params = new URLSearchParams();
  if (input.from) {
    params.set('from', input.from);
  }
  if (input.to) {
    params.set('to', input.to);
  }
  if (input.format) {
    params.set('format', input.format);
  }
  return params.size > 0 ? `?${params.toString()}` : '';
}

async function rawApiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const accessToken = getAccessToken();
  const orgId = getActiveOrgId();
  if (!accessToken || !orgId) {
    throw new ApiClientError('missing_auth', 'Thiếu phiên đăng nhập.');
  }

  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(
    buildApiHeaders({ accessToken, orgId }),
  )) {
    headers.set(key, headers.get(key) ?? value);
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const { code, message } = await parseApiErrorBody(response);
    throw new ApiClientError(
      code,
      message ?? `Yêu cầu API thất bại (${response.status})`,
      response.status,
    );
  }

  return response;
}
