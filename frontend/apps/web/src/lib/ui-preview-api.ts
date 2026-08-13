const PREVIEW_ORG_ID = 'preview-org';
const PREVIEW_NOW = '2026-01-01T00:00:00.000Z';

const previewMembership = {
  organization: {
    id: PREVIEW_ORG_ID,
    name: 'Cửa hàng demo',
    slug: 'cua-hang-demo',
    plan: 'growth',
    settingsJson: {
      autoConfirm: false,
      aiReplies: true,
      aiDraftOrders: true,
      aiProductSuggestions: true,
    },
    timezone: 'Asia/Ho_Chi_Minh',
    locale: 'vi-VN',
    suspendedAt: null,
    createdAt: PREVIEW_NOW,
    updatedAt: PREVIEW_NOW,
  },
  membership: {
    id: 'preview-membership',
    orgId: PREVIEW_ORG_ID,
    userId: 'preview-user',
    role: 'owner',
  },
};

/**
 * Small in-browser API substitute for UI-only inspection. It intentionally
 * returns empty collections so pages render their real empty states without
 * pretending that demo data came from a real shop.
 */
export async function previewApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = new URL(path, 'http://omni-ui-preview.local');
  const method = (init.method ?? 'GET').toUpperCase();

  if (pathWithoutQuery(url) === '/v1/orgs' && method === 'GET') {
    return [previewMembership] as T;
  }

  if (method === 'POST' && pathWithoutQuery(url) === '/v1/advisor/suggest') {
    return {
      suggestionsText:
        'Đây là gợi ý xem thử. Hãy kết nối API thật để nhận phân tích theo dữ liệu shop.',
      disclaimer: 'Dữ liệu trong chế độ xem UI chỉ là mô phỏng.',
      promptVersion: 'preview',
      model: 'preview',
      citations: [],
      entitlement: {
        allowed: true,
        note: 'Đang ở chế độ xem UI.',
      },
    } as T;
  }

  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    return previewWriteResponse<T>(url, method, init);
  }

  return previewReadResponse<T>(url);
}

export async function previewRawApiFetch(): Promise<Response> {
  return new Response('Chế độ xem UI - không có dữ liệu xuất.', {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="omni-preview.csv"',
    },
  });
}

function previewReadResponse<T>(url: URL): T {
  const path = pathWithoutQuery(url);

  if (path === '/v1/channels') return [] as T;
  if (path === '/v1/inbox/conversations') return { conversations: [] } as T;
  if (path === '/v1/catalog/products') return { products: [] } as T;
  if (path === '/v1/inventory/movements') return { movements: [] } as T;
  if (path === '/v1/inventory/low-stock') {
    return {
      threshold: Number(url.searchParams.get('threshold') ?? 5),
      variants: [],
    } as T;
  }
  if (path === '/v1/warehouses') return { warehouses: [] } as T;
  if (path === '/v1/suppliers') return { suppliers: [] } as T;
  if (path === '/v1/purchase-orders') return { purchaseOrders: [] } as T;
  if (path === '/v1/orders') return { orders: [] } as T;
  if (path === '/v1/shipping/shipments') return { shipments: [] } as T;
  if (path === '/v1/cod/report') {
    return {
      summary: {
        openCount: 0,
        discrepancyCount: 0,
        expectedVnd: '0',
        collectedVnd: '0',
        deltaVnd: '0',
      },
      expectations: [],
      expectationsTruncated: false,
      discrepancies: [],
      discrepanciesTruncated: false,
    } as T;
  }
  if (path === '/v1/pnl/summary') {
    return {
      revenueVnd: '0',
      cogsVnd: '0',
      grossProfitVnd: '0',
      shippingVnd: '0',
      adSpendVnd: '0',
      netProfitVnd: '0',
      orderCount: 0,
      days: [],
    } as T;
  }
  if (path === '/v1/pnl/by-sku') return { items: [] } as T;
  if (path === '/v1/ad-spend') return { adSpend: [] } as T;
  if (path === '/v1/ad-spend/summary') {
    return { totalVnd: '0', days: [] } as T;
  }
  if (path === '/v1/attribution/summary') {
    return { totalOrders: 0, totalRevenueVnd: '0', sources: [] } as T;
  }
  if (path === '/v1/content-calendar') return { items: [] } as T;
  if (path === '/v1/einvoice/jobs') return { jobs: [] } as T;
  if (path === '/v1/billing/plan') {
    return {
      plan: 'preview',
      billingStatus: 'active',
      billingCustomerEmail: null,
      planRenewsAt: null,
      entitlements: {
        orgId: PREVIEW_ORG_ID,
        maxPages: 0,
        aiMonthlyTokenLimit: 0,
        autoConfirmAllowed: false,
        autoConfirmBlockedReason: 'Chế độ xem UI',
        updatedAt: PREVIEW_NOW,
      },
      dunning: { autoConfirmBlocked: true, reason: 'Chế độ xem UI' },
    } as T;
  }
  if (path === '/v1/billing/usage') {
    return {
      periodStart: PREVIEW_NOW,
      pagesConnectedCount: 0,
      aiTokensMonth: 0,
      ordersCountMonth: 0,
    } as T;
  }
  if (path === '/v1/billing/invoices') return { invoices: [] } as T;
  if (path === '/v1/orgs') return [previewMembership] as T;
  if (/^\/v1\/orgs\/[^/]+\/invites$/.test(path)) return { invites: [] } as T;
  if (/^\/v1\/orgs\/[^/]+\/settings$/.test(path)) {
    return previewMembership.organization as T;
  }

  // Detail pages are not reachable with the empty preview collections, but a
  // safe empty object keeps future read-only preview calls from hitting a
  // real backend unexpectedly.
  return {} as T;
}

function previewWriteResponse<T>(
  url: URL,
  method: string,
  init: RequestInit,
): T {
  const path = pathWithoutQuery(url);
  const body = parseBody(init.body);

  if (path === '/v1/channels/meta/oauth-url') {
    return { url: '#' } as T;
  }
  if (path === '/v1/ad-spend/import') {
    return { importedCount: 0, adSpend: [] } as T;
  }
  if (path === '/v1/orgs') return previewMembership as T;
  if (/^\/v1\/orgs\/[^/]+\/settings$/.test(path)) {
    return {
      ...previewMembership.organization,
      settingsJson: {
        ...previewMembership.organization.settingsJson,
        ...(isRecord(body) ? body : {}),
      },
    } as T;
  }
  if (/^\/v1\/orgs\/[^/]+\/invites$/.test(path)) {
    return {
      invite: {
        id: 'preview-invite',
        orgId: PREVIEW_ORG_ID,
        email: isRecord(body) && typeof body.email === 'string' ? body.email : 'preview@example.com',
        role: isRecord(body) && typeof body.role === 'string' ? body.role : 'cskh',
        expiresAt: PREVIEW_NOW,
        createdAt: PREVIEW_NOW,
        acceptedAt: null,
      },
      token: 'preview-invite-token',
    } as T;
  }
  if (path === '/v1/content-calendar' || path.startsWith('/v1/content-calendar/')) {
    return {
      item: {
        id: 'preview-calendar-item',
        orgId: PREVIEW_ORG_ID,
        title: isRecord(body) && typeof body.title === 'string' ? body.title : 'Bài viết xem thử',
        body: null,
        plannedAt: PREVIEW_NOW,
        status: 'idea',
        channelHint: null,
        autoPostEnabled: false,
        createdAt: PREVIEW_NOW,
        updatedAt: PREVIEW_NOW,
      },
    } as T;
  }
  if (path.includes('/messages')) {
    return {
      message: {
        id: 'preview-message',
        conversationId: 'preview-conversation',
        direction: 'outbound',
        senderType: 'staff',
        rawType: 'text',
        bodyText: isRecord(body) && typeof body.text === 'string' ? body.text : '',
        providerMessageId: null,
        createdAt: PREVIEW_NOW,
      },
    } as T;
  }
  if (path === '/v1/advisor/suggest') {
    return previewApiFetch<T>(path, init) as unknown as T;
  }
  if (path.includes('/orders/') || path === '/v1/orders') return { order: {} } as T;
  if (path.includes('/shipping/shipments')) return { shipment: {} } as T;
  if (path.includes('/catalog/products')) return { product: {} } as T;
  if (path.includes('/warehouses')) return { warehouse: {} } as T;
  if (path === '/v1/suppliers') return { supplier: {} } as T;
  if (path.includes('/purchase-orders')) return { purchaseOrder: {} } as T;
  if (path.includes('/einvoice')) return { job: {} } as T;
  if (path.includes('/cod/collections')) return { collection: {} } as T;
  if (path.includes('/cod/reconcile')) {
    return { reconciled: 0, results: [], remaining: 0, hasMore: false } as T;
  }
  if (path.includes('/channels')) {
    return {
      connection: {
        id: 'preview-channel',
        provider: 'preview',
        externalPageId: 'preview-page',
        status: 'active',
        createdAt: PREVIEW_NOW,
      },
    } as T;
  }

  return method === 'DELETE' ? (undefined as T) : ({} as T);
}

function pathWithoutQuery(url: URL): string {
  return url.pathname.replace(/\/$/, '') || '/';
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
