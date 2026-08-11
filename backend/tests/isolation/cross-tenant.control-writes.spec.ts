import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression proof for 20260729000000_revoke_authenticated_writes_control_tables.sql.
 *
 * Closes a within-org privilege-escalation + audit-bypass hole: authenticated org
 * members could POST directly to PostgREST and write api_keys / outbound_webhooks /
 * content_calendar_items, skipping the Nest permission matrix + audit logging.
 *
 * After the fix `authenticated` has SELECT only; INSERT/UPDATE/DELETE go through
 * `service_role` (which the Nest services use). This spec proves:
 *   1. an authenticated member INSERT into all three tables is REJECTED (42501),
 *   2. the `service_role` client can still INSERT (Nest write path intact),
 *   3. a member can still SELECT its own org's rows (read path preserved).
 *
 * Docker-backed Supabase Data API — requires local `supabase start` with migrations
 * applied. Default keys = local Supabase demo JWT pair (public; not production secrets).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const PARENT = resolve(ROOT, '../..');

const LOCAL_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const LOCAL_SERVICE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

loadEnvFile(resolve(ROOT, '.env'));
loadEnvFile(resolve(PARENT, '.env'));

const SUPABASE_URL = (
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  'http://127.0.0.1:54721'
).replace(/\/$/, '');
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  LOCAL_ANON;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY ??
  LOCAL_SERVICE;

const REVOKE_MIGRATION = resolve(
  ROOT,
  'backend/database/supabase/migrations/20260729000000_revoke_authenticated_writes_control_tables.sql',
);

const CONTROL_TABLES = [
  'api_keys',
  'outbound_webhooks',
  'content_calendar_items',
] as const;

describe('control-table write-revoke migration proof (always-on)', () => {
  const sql = readFileSync(REVOKE_MIGRATION, 'utf8');
  // Structural assertions run against the statements only, never the rationale prose.
  const statements = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('drops the three permissive *_write_member policies', () => {
    expect(statements).toMatch(
      /drop policy if exists api_keys_write_member on public\.api_keys/i,
    );
    expect(statements).toMatch(
      /drop policy if exists outbound_webhooks_write_member on public\.outbound_webhooks/i,
    );
    expect(statements).toMatch(
      /drop policy if exists content_calendar_items_write_member on public\.content_calendar_items/i,
    );
  });

  it('revokes insert/update/delete (but NOT select) from authenticated on all three tables', () => {
    expect(statements).toMatch(
      /revoke insert,\s*update,\s*delete on table[\s\S]*public\.api_keys[\s\S]*public\.outbound_webhooks[\s\S]*public\.content_calendar_items[\s\S]*from authenticated/i,
    );

    const revoke = statements.match(/revoke\s+([a-z,\s]+?)\s+on table/i);
    expect(revoke).not.toBeNull();
    const privileges = revoke![1].toLowerCase();
    expect(privileges).toContain('insert');
    expect(privileges).toContain('update');
    expect(privileges).toContain('delete');
    // The SELECT grant must survive — members reading their own org rows is intended.
    expect(privileges).not.toContain('select');

    // service_role's grant must be left untouched by this migration.
    expect(statements).not.toMatch(/revoke[\s\S]*service_role/i);
  });

  it('documents the security rationale in a leading comment block', () => {
    expect(sql).toMatch(/^--/);
    expect(sql).toMatch(/escalation|audit/i);
  });
});

describe('authenticated members cannot write control tables via Data API', () => {
  let userToken: string;
  let orgId: string;
  let stamp: string;
  const seeded: Record<string, Record<string, unknown>> = {};

  beforeAll(async () => {
    await assertSupabaseReachable();

    stamp = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    const password = 'TestPass123!';
    const email = `ctrl-writes-${stamp}@example.com`;

    const user = await adminCreateUser(email, password);
    const org = await createOrgWithOwner(
      user.id,
      `Ctrl Writes Org ${stamp}`,
      `ctrl-writes-${stamp}`,
    );
    orgId = org.organization.id as string;

    // Seed one row per table via service_role so the SELECT path has data to read.
    seeded.api_keys = await serviceInsert('api_keys', apiKeyBody(orgId, stamp));
    seeded.outbound_webhooks = await serviceInsert(
      'outbound_webhooks',
      webhookBody(orgId),
    );
    seeded.content_calendar_items = await serviceInsert(
      'content_calendar_items',
      calendarBody(orgId, stamp),
    );

    userToken = await passwordGrant(email, password);
  }, 60_000);

  it('service_role can still insert into all three control tables (Nest write path intact)', async () => {
    const key = await serviceInsert('api_keys', apiKeyBody(orgId, `${stamp}-svc`));
    expect(key.id).toBeTruthy();

    const webhook = await serviceInsert('outbound_webhooks', webhookBody(orgId));
    expect(webhook.id).toBeTruthy();

    const item = await serviceInsert(
      'content_calendar_items',
      calendarBody(orgId, `${stamp}-svc`),
    );
    expect(item.id).toBeTruthy();
  });

  it('rejects an authenticated member INSERT into api_keys (escalation path closed)', async () => {
    const res = await dataApi('POST', 'api_keys', {
      token: userToken,
      body: apiKeyBody(orgId, `${stamp}-attack`),
    });
    expect(res.status).toBe(403);
    expect(String(res.text)).toMatch(/permission denied|42501/i);
  });

  it('rejects an authenticated member INSERT into outbound_webhooks', async () => {
    const res = await dataApi('POST', 'outbound_webhooks', {
      token: userToken,
      body: webhookBody(orgId),
    });
    expect(res.status).toBe(403);
    expect(String(res.text)).toMatch(/permission denied|42501/i);
  });

  it('rejects an authenticated member INSERT into content_calendar_items', async () => {
    const res = await dataApi('POST', 'content_calendar_items', {
      token: userToken,
      body: calendarBody(orgId, `${stamp}-attack`),
    });
    expect(res.status).toBe(403);
    expect(String(res.text)).toMatch(/permission denied|42501/i);
  });

  it('still allows an authenticated member to SELECT its own org rows (read path preserved)', async () => {
    for (const table of CONTROL_TABLES) {
      const res = await dataApi('GET', `${table}?org_id=eq.${orgId}`, {
        token: userToken,
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      expect(res.json).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: seeded[table].id }),
        ]),
      );
    }
  });
});

function apiKeyBody(orgId: string, salt: string): Record<string, unknown> {
  const suffix = randomBytes(8).toString('hex');
  return {
    org_id: orgId,
    name: `probe key ${salt}`,
    key_prefix: `omni_${suffix}`,
    key_hash: createHash('sha256').update(`${salt}-${suffix}`).digest('hex'),
    scopes: ['orders.read'],
  };
}

function webhookBody(orgId: string): Record<string, unknown> {
  return {
    org_id: orgId,
    url: 'https://attacker.example.com/hook',
    secret_enc: 'probe-secret',
    events: ['order.created'],
  };
}

function calendarBody(orgId: string, salt: string): Record<string, unknown> {
  return {
    org_id: orgId,
    title: `Probe calendar item ${salt}`,
    planned_at: new Date().toISOString(),
  };
}

function loadEnvFile(path: string) {
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
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function assertSupabaseReachable() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: ANON_KEY },
    });
    if (!res.ok) {
      throw new Error(`auth health ${res.status}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Local Supabase unreachable at ${SUPABASE_URL} (${message}). Start with \`supabase start --workdir backend/database\` (see backend/tests/isolation/README.md).`,
    );
  }
}

async function adminCreateUser(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    msg?: string;
    message?: string;
  };
  if (!res.ok || !json.id) {
    throw new Error(
      `adminCreateUser ${email} → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return { id: json.id, email };
}

async function createOrgWithOwner(userId: string, name: string, slug: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/create_organization_with_owner`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_owner_user_id: userId,
        p_name: name,
        p_slug: slug,
      }),
    },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `create_organization_with_owner → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  const row = Array.isArray(json) ? json[0] : json;
  if (!row?.organization?.id || !row?.membership?.id) {
    throw new Error(`unexpected org bootstrap payload: ${JSON.stringify(json)}`);
  }
  return row as {
    organization: { id: string };
    membership: { id: string };
  };
}

async function serviceInsert(
  table: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`insert ${table} → ${res.status} ${JSON.stringify(json)}`);
  }
  const row = Array.isArray(json) ? json[0] : json;
  if (!row?.id) {
    throw new Error(`insert ${table} missing id: ${JSON.stringify(json)}`);
  }
  return row as Record<string, unknown>;
}

async function passwordGrant(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      authorization: `Bearer ${ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(
      `passwordGrant ${email} → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json.access_token;
}

async function dataApi(
  method: string,
  path: string,
  options: { token: string; body?: unknown },
) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      authorization: `Bearer ${options.token}`,
      ...(options.body !== undefined
        ? {
            'content-type': 'application/json',
            prefer: 'return=representation',
          }
        : {}),
    },
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}
