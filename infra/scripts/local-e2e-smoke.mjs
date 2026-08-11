#!/usr/bin/env node
/**
 * A2 local e2e smoke (API-level, no Meta / no Playwright).
 * Happy path: health → signup → org → invite accept → catalog → stock →
 * draft → confirm → ship → done → e-invoice issue → export CSV.
 *
 * Prerequisites: Docker Supabase + `pnpm run dev:local` (API from infra/config/local-ports.json).
 * Env: SUPABASE_URL + SUPABASE_ANON_KEY (parent `.env` or process env).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PARENT = resolve(ROOT, '../..');

function loadLockedApiBase() {
  const portsPath = resolve(ROOT, 'infra/config/local-ports.json');
  if (existsSync(portsPath)) {
    try {
      const ports = JSON.parse(readFileSync(portsPath, 'utf8'));
      if (ports?.urls?.api) return String(ports.urls.api).replace(/\/$/, '');
    } catch {
      /* fall through */
    }
  }
  return 'http://127.0.0.1:4701';
}

function loadLockedAiBase() {
  const portsPath = resolve(ROOT, 'infra/config/local-ports.json');
  if (existsSync(portsPath)) {
    try {
      const ports = JSON.parse(readFileSync(portsPath, 'utf8'));
      if (ports?.urls?.ai) return String(ports.urls.ai).replace(/\/$/, '');
    } catch {
      /* fall through */
    }
  }
  return 'http://127.0.0.1:4702';
}

const API_BASE = (
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  loadLockedApiBase()
).replace(/\/$/, '');
const AI_BASE = (process.env.AI_BASE_URL ?? loadLockedAiBase()).replace(/\/$/, '');
const stamp = Date.now().toString(36);
const suffix = randomBytes(3).toString('hex');

function loadEnvFile(path, { overwrite = false } = {}) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (overwrite || process.env[key] === undefined) process.env[key] = val;
  }
}

function loadLockedSupabaseBase() {
  const portsPath = resolve(ROOT, 'infra/config/local-ports.json');
  if (existsSync(portsPath)) {
    try {
      const ports = JSON.parse(readFileSync(portsPath, 'utf8'));
      if (ports?.urls?.supabase) return String(ports.urls.supabase).replace(/\/$/, '');
    } catch {
      /* fall through */
    }
  }
  return '';
}

// Repo `.env` (ports:sync) wins over stale shell SUPABASE_URL (e.g. legacy :54321).
loadEnvFile(resolve(ROOT, '.env'), { overwrite: true });
for (const path of [resolve(PARENT, '.env'), resolve(ROOT, 'backend/apps/api/.env')]) {
  loadEnvFile(path);
}
const lockedSupabase = loadLockedSupabaseBase();
if (lockedSupabase) process.env.SUPABASE_URL = lockedSupabase;

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY ??
  '';
const SERVICE_M2M_KEY = process.env.SERVICE_M2M_KEY ?? '';

function fail(step, detail) {
  console.error(`FAIL [${step}] ${detail}`);
  process.exit(1);
}

function ok(step, detail = '') {
  console.log(`PASS [${step}]${detail ? ` ${detail}` : ''}`);
}

async function api(path, { method = 'GET', token, orgId, body, headers = {} } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'x-org-id': orgId } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function supabaseRest(path, { token } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: ANON_KEY,
      authorization: `Bearer ${token ?? ANON_KEY}`,
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function aiProcessMessage({ orgId, message }) {
  const res = await fetch(`${AI_BASE}/internal/v1/ai/process-message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-service-key': SERVICE_M2M_KEY,
    },
    body: JSON.stringify({ orgId, message, topK: 5 }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

// Regression check for the bug where backend/apps/ai silently used the wrong
// SERVICE_M2M_KEY (fell back to the hardcoded default because
// infra/scripts/dev-local.ps1 never copied the root .env to backend/apps/ai/.env, while
// backend/apps/api loaded the real key). Every API -> AI knowledge-reindex call
// (POST /internal/v1/reindex, triggered here by product creation) silently
// failed with 401 and no knowledge_chunks row was ever written — the
// product-creation request itself still returned 200, so nothing in the
// existing API-level assertions could catch it. Polling knowledge_chunks
// for the product we just created is the most faithful reproduction of the
// actual failure mode, end to end (outbox -> Inngest -> AI -> chunks).
async function waitForKnowledgeChunks({
  orgId,
  token,
  sourceId,
  sourceType = 'product',
  timeoutMs = 30_000,
  intervalMs = 1_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { res, json, text } = await supabaseRest(
      `knowledge_chunks?org_id=eq.${orgId}&source_type=eq.${sourceType}&source_id=eq.${sourceId}&select=id`,
      { token },
    );
    if (res.ok && Array.isArray(json) && json.length > 0) {
      return json.length;
    }
    last = { status: res.status, body: text };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(
    'knowledge.reindex',
    `no knowledge_chunks row for ${sourceType} ${sourceId} after ${timeoutMs}ms ` +
      `(last poll: ${last ? `${last.status} ${last.body}` : 'no attempt made'}). ` +
      'If the AI service logs show 401 on POST /internal/v1/reindex: backend/apps/ai reads ' +
      'SERVICE_M2M_KEY from backend/apps/ai/.env (its own working directory), not the root .env — ' +
      'check backend/apps/ai/.env exists and its SERVICE_M2M_KEY matches the root .env ' +
      '(infra/scripts/dev-local.ps1 copies it on every dev:local run). Also confirm the AI and ' +
      'Inngest dev services are running (pnpm run dev:local).',
  );
  return 0;
}

async function authSignup(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      authorization: `Bearer ${ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail('auth.signup', `${email} → ${res.status} ${JSON.stringify(json)}`);
  }
  const accessToken = json.access_token ?? json.session?.access_token;
  if (accessToken) {
    return {
      accessToken,
      userId: json.user?.id ?? json.id,
      email,
    };
  }
  // Email confirm enabled: fall back to password grant or admin confirm.
  return authSignIn(email, password);
}

async function authSignIn(email, password) {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        authorization: `Bearer ${ANON_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.access_token) {
    return { accessToken: json.access_token, userId: json.user?.id, email };
  }

  if (!SERVICE_KEY) {
    fail(
      'auth.signin',
      `${email} → ${res.status} ${JSON.stringify(json)} (no SERVICE_ROLE for admin confirm)`,
    );
  }

  // Admin create+confirm when local confirmations block password grant.
  const adminRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });
  const adminJson = await adminRes.json().catch(() => ({}));
  if (!adminRes.ok && adminRes.status !== 422) {
    fail(
      'auth.admin',
      `${email} → ${adminRes.status} ${JSON.stringify(adminJson)}`,
    );
  }

  const retry = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        authorization: `Bearer ${ANON_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const retryJson = await retry.json().catch(() => ({}));
  if (!retry.ok || !retryJson.access_token) {
    fail('auth.signin', `${email} → ${retry.status} ${JSON.stringify(retryJson)}`);
  }
  return {
    accessToken: retryJson.access_token,
    userId: retryJson.user?.id,
    email,
  };
}

async function main() {
  console.log(`local-e2e-smoke → API ${API_BASE} · Supabase ${SUPABASE_URL}`);

  let health;
  try {
    health = await api('/health');
  } catch (err) {
    fail(
      'health',
      `API unreachable at ${API_BASE}/health — start stack: pnpm run dev:local (${err.message})`,
    );
  }
  if (!health.res.ok || health.json?.status !== 'ok') {
    fail(
      'health',
      `expected 200 {"status":"ok"}, got ${health.res.status} ${health.text}`,
    );
  }
  ok('health');

  if (!SUPABASE_URL || !ANON_KEY) {
    fail(
      'env',
      'SUPABASE_URL and SUPABASE_ANON_KEY required (parent .env or process env)',
    );
  }

  const password = `Smoke_${suffix}_Aa1!`;
  const ownerEmail = `owner.${stamp}.${suffix}@example.com`;
  const cskhEmail = `cskh.${stamp}.${suffix}@example.com`;
  const slug = `smoke-${stamp}-${suffix}`;

  const owner = await authSignup(ownerEmail, password);
  ok('auth.owner', owner.email);

  const cskh = await authSignup(cskhEmail, password);
  ok('auth.cskh', cskh.email);

  const orgRes = await api('/v1/orgs', {
    method: 'POST',
    token: owner.accessToken,
    body: { name: `Smoke Org ${stamp}`, slug },
  });
  if (!orgRes.res.ok) {
    fail('org.create', `${orgRes.res.status} ${orgRes.text}`);
  }
  const orgId = orgRes.json?.organization?.id;
  if (!orgId) fail('org.create', `missing organization.id: ${orgRes.text}`);
  ok('org.create', orgId);

  const inviteRes = await api(`/v1/orgs/${orgId}/invites`, {
    method: 'POST',
    token: owner.accessToken,
    orgId,
    body: { email: cskhEmail, role: 'cskh' },
  });
  if (!inviteRes.res.ok) {
    fail('invite.create', `${inviteRes.res.status} ${inviteRes.text}`);
  }
  const token = inviteRes.json?.token;
  if (!token || token.length < 32) {
    fail('invite.create', `missing raw token: ${inviteRes.text}`);
  }
  ok('invite.create', inviteRes.json?.invite?.id ?? 'token');

  const acceptRes = await api('/v1/invites/accept', {
    method: 'POST',
    token: cskh.accessToken,
    body: { token },
  });
  if (!acceptRes.res.ok) {
    fail('invite.accept', `${acceptRes.res.status} ${acceptRes.text}`);
  }
  if (acceptRes.json?.membership?.role !== 'cskh') {
    fail('invite.accept', `expected role cskh: ${acceptRes.text}`);
  }
  ok('invite.accept', acceptRes.json.membership.role);

  const metaUrlRes = await api('/v1/channels/meta/oauth-url', {
    token: owner.accessToken,
    orgId,
  });
  if (!metaUrlRes.res.ok) {
    fail('meta.oauth-url', `${metaUrlRes.res.status} ${metaUrlRes.text}`);
  }
  const metaUrl = new URL(metaUrlRes.json?.url ?? '');
  if (
    metaUrl.searchParams.get('code') !== 'local-meta-code' ||
    !metaUrl.searchParams.get('state')
  ) {
    fail('meta.oauth-url', `expected local OAuth stub URL: ${metaUrlRes.text}`);
  }
  const metaCompleteRes = await api('/v1/channels/meta/complete', {
    method: 'POST',
    token: owner.accessToken,
    orgId,
    body: {
      code: metaUrl.searchParams.get('code'),
      state: metaUrl.searchParams.get('state'),
    },
  });
  if (!metaCompleteRes.res.ok) {
    fail('meta.oauth-complete', `${metaCompleteRes.res.status} ${metaCompleteRes.text}`);
  }
  if ((metaCompleteRes.json?.connections?.length ?? 0) < 1) {
    fail('meta.oauth-complete', `expected local page connection: ${metaCompleteRes.text}`);
  }
  ok('meta.oauth-complete', `${metaCompleteRes.json.connections.length} local connection(s)`);

  const sku = `SMOKE-${suffix}`.toUpperCase();
  const productRes = await api('/v1/catalog/products', {
    method: 'POST',
    token: owner.accessToken,
    orgId,
    body: {
      title: `Smoke Product ${stamp}`,
      description: 'A2 local e2e smoke',
      variants: [
        {
          sku,
          title: 'Default',
          priceVnd: '99000',
          stockQty: 0,
          cogsVnd: '40000',
        },
      ],
    },
  });
  if (!productRes.res.ok) {
    fail('catalog.product', `${productRes.res.status} ${productRes.text}`);
  }
  const variantId = productRes.json?.product?.variants?.[0]?.id;
  if (!variantId) {
    fail('catalog.product', `missing variant id: ${productRes.text}`);
  }
  ok('catalog.product', `${productRes.json.product.id} / ${variantId}`);

  const stockRes = await api('/v1/inventory/adjust', {
    method: 'POST',
    token: owner.accessToken,
    orgId,
    body: {
      variantId,
      qtyDelta: 10,
      reason: 'a2-smoke',
      movementType: 'inbound',
    },
  });
  if (!stockRes.res.ok) {
    fail('inventory.adjust', `${stockRes.res.status} ${stockRes.text}`);
  }
  ok('inventory.adjust');

  const draftKey = `smoke-draft-${randomUUID()}`;
  const draftRes = await api('/v1/orders', {
    method: 'POST',
    token: owner.accessToken,
    orgId,
    headers: { 'idempotency-key': draftKey },
    body: {
      paymentMethod: 'cod',
      customerName: 'Smoke Customer',
      phoneE164: '+84901234567',
      addressText: '1 Smoke St, HCMC',
      items: [{ variantId, qty: 1 }],
    },
  });
  if (!draftRes.res.ok) {
    fail('orders.draft', `${draftRes.res.status} ${draftRes.text}`);
  }
  const orderId = draftRes.json?.order?.id;
  const draftStatus = draftRes.json?.order?.status;
  if (!orderId) fail('orders.draft', `missing order.id: ${draftRes.text}`);
  // auto_confirm orgs may return confirmed already — still exercise confirm when draft.
  if (draftStatus === 'confirmed') {
    ok('orders.draft', `${orderId} (auto-confirmed)`);
  } else if (draftStatus !== 'draft') {
    fail('orders.draft', `unexpected status ${draftStatus}: ${draftRes.text}`);
  } else {
    ok('orders.draft', orderId);
    const confirmRes = await api(`/v1/orders/${orderId}/confirm`, {
      method: 'POST',
      token: owner.accessToken,
      orgId,
      headers: { 'idempotency-key': `smoke-confirm-${randomUUID()}` },
    });
    if (!confirmRes.res.ok) {
      fail('orders.confirm', `${confirmRes.res.status} ${confirmRes.text}`);
    }
    if (confirmRes.json?.order?.status !== 'confirmed') {
      fail('orders.confirm', `expected confirmed: ${confirmRes.text}`);
    }
    ok('orders.confirm', orderId);
  }

  const shipRes = await api(`/v1/orders/${orderId}/ship`, {
    method: 'POST',
    token: owner.accessToken,
    orgId,
  });
  if (!shipRes.res.ok) {
    fail('orders.ship', `${shipRes.res.status} ${shipRes.text}`);
  }
  if (shipRes.json?.order?.status !== 'shipped') {
    fail('orders.ship', `expected shipped: ${shipRes.text}`);
  }
  ok('orders.ship', orderId);

  // Regression check for the bug where no endpoint, service method, webhook,
  // or cron anywhere in the API ever set orders.status = 'done', which meant
  // einvoice.service.ts's `order.status === 'done'` gate (issue(), ~L124)
  // could never be reached through the app's own intended lifecycle
  // (create -> confirm -> ship -> ???). POST /v1/orders/:orderId/done closes
  // that gap; the assertions below exercise the real HTTP surface end to
  // end (not just markOrderDone in isolation) to prove e-invoice issuance is
  // now actually reachable.
  const doneRes = await api(`/v1/orders/${orderId}/done`, {
    method: 'POST',
    token: owner.accessToken,
    orgId,
  });
  if (!doneRes.res.ok) {
    fail('orders.done', `${doneRes.res.status} ${doneRes.text}`);
  }
  if (doneRes.json?.order?.status !== 'done') {
    fail('orders.done', `expected done: ${doneRes.text}`);
  }
  ok('orders.done', orderId);

  const einvoiceRes = await api('/v1/einvoice/issue', {
    method: 'POST',
    token: owner.accessToken,
    orgId,
    body: { orderId, provider: 'stub' },
  });
  if (!einvoiceRes.res.ok) {
    fail('einvoice.issue', `${einvoiceRes.res.status} ${einvoiceRes.text}`);
  }
  if (einvoiceRes.json?.job?.status !== 'sent') {
    fail('einvoice.issue', `expected sent job: ${einvoiceRes.text}`);
  }
  ok('einvoice.issue', einvoiceRes.json.job.id);

  const exportRes = await api('/v1/orders/export?format=csv', {
    token: owner.accessToken,
    orgId,
  });
  if (!exportRes.res.ok) {
    fail('orders.export', `${exportRes.res.status} ${exportRes.text.slice(0, 200)}`);
  }
  const ctype = exportRes.res.headers.get('content-type') ?? '';
  if (!exportRes.text || exportRes.text.length < 10) {
    fail('orders.export', 'empty CSV body');
  }
  ok('orders.export', `${exportRes.res.status} ${ctype || 'text'} (${exportRes.text.length}b)`);

  const chunkCount = await waitForKnowledgeChunks({
    orgId,
    token: owner.accessToken,
    sourceId: productRes.json.product.id,
  });
  ok('knowledge.reindex', `${chunkCount} chunk(s) for product ${productRes.json.product.id}`);

  const aiRes = await aiProcessMessage({
    orgId,
    message: `Sản phẩm ${sku} hiện còn hàng không?`,
  });
  if (!aiRes.res.ok) {
    fail('ai.process-message', `${aiRes.res.status} ${aiRes.text}`);
  }
  if (aiRes.json?.model !== 'advisor-stub') {
    fail('ai.process-message', `expected local advisor-stub: ${aiRes.text}`);
  }
  ok('ai.process-message', `local model=${aiRes.json.model}`);

  // Fingerprint for logs only — not a secret.
  const runId = createHash('sha256')
    .update(`${orgId}:${orderId}:${stamp}`)
    .digest('hex')
    .slice(0, 12);
  console.log(`GREEN local e2e smoke ok run=${runId} org=${orgId} order=${orderId}`);
}

main().catch((err) => {
  fail('unhandled', err?.stack ?? String(err));
});
