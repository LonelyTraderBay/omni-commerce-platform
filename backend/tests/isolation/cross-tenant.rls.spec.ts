import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Docker-backed Supabase RLS E2E (Data API).
 * Requires local `supabase start` (or CI migrate stack) with migrations applied.
 * Default keys = local Supabase demo JWT pair (public; not production secrets).
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

const HARDEN_MIGRATION = resolve(
  ROOT,
  'backend/database/supabase/migrations/20260724193000_harden_control_plane_and_org_bootstrap.sql',
);

describe('control-plane migration proof (always-on)', () => {
  it('revokes authenticated insert/update/delete on memberships, entitlements, feature_flags', () => {
    const sql = readFileSync(HARDEN_MIGRATION, 'utf8');
    expect(sql).toMatch(
      /drop policy if exists memberships_update_member on public\.memberships/i,
    );
    expect(sql).toMatch(
      /drop policy if exists entitlements_update_member on public\.entitlements/i,
    );
    expect(sql).toMatch(
      /drop policy if exists feature_flags_update_member on public\.feature_flags/i,
    );
    expect(sql).toMatch(
      /revoke insert,\s*update,\s*delete on table[\s\S]*public\.memberships[\s\S]*from anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /revoke insert,\s*update,\s*delete on table[\s\S]*public\.entitlements[\s\S]*from anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /revoke insert,\s*update,\s*delete on table[\s\S]*public\.feature_flags[\s\S]*from anon,\s*authenticated/i,
    );
  });
});

describe('cross-tenant RLS via local Supabase Data API', () => {
  let userAToken: string;
  let orgBId: string;
  let membershipBId: string;
  let featureFlagBId: string;

  beforeAll(async () => {
    await assertSupabaseReachable();

    const stamp = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    const password = 'TestPass123!';
    const emailA = `rls-a-${stamp}@example.com`;
    const emailB = `rls-b-${stamp}@example.com`;

    const userA = await adminCreateUser(emailA, password);
    const userB = await adminCreateUser(emailB, password);

    const orgA = await createOrgWithOwner(
      userA.id,
      `RLS Org A ${stamp}`,
      `rls-a-${stamp}`,
    );
    const orgB = await createOrgWithOwner(
      userB.id,
      `RLS Org B ${stamp}`,
      `rls-b-${stamp}`,
    );

    orgBId = orgB.organization.id as string;
    membershipBId = orgB.membership.id as string;

    const flag = await serviceInsert('feature_flags', {
      key: `rls-probe-${stamp}`,
      org_id: orgBId,
      enabled: false,
      payload_json: {},
    });
    featureFlagBId = flag.id as string;

    userAToken = await passwordGrant(emailA, password);

    // Sanity: user A can see own org membership via select grant + RLS.
    const own = await dataApi('GET', `memberships?org_id=eq.${orgA.organization.id}`, {
      token: userAToken,
    });
    expect(own.status).toBe(200);
    expect(own.json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          org_id: orgA.organization.id,
          user_id: userA.id,
        }),
      ]),
    );
  }, 60_000);

  it('rls denies cross-tenant direct Supabase updates', async () => {
    const membershipPatch = await dataApi(
      'PATCH',
      `memberships?id=eq.${membershipBId}`,
      { token: userAToken, body: { role: 'cskh' } },
    );
    expect(membershipPatch.status).toBe(403);
    expect(String(membershipPatch.text)).toMatch(/permission denied|42501/i);

    const entitlementsPatch = await dataApi(
      'PATCH',
      `entitlements?org_id=eq.${orgBId}`,
      { token: userAToken, body: { max_pages: 99 } },
    );
    expect(entitlementsPatch.status).toBe(403);
    expect(String(entitlementsPatch.text)).toMatch(/permission denied|42501/i);

    const flagPatch = await dataApi(
      'PATCH',
      `feature_flags?id=eq.${featureFlagBId}`,
      { token: userAToken, body: { enabled: true } },
    );
    expect(flagPatch.status).toBe(403);
    expect(String(flagPatch.text)).toMatch(/permission denied|42501/i);

    // Cross-tenant SELECT must not leak org B memberships to user A.
    const leaked = await dataApi('GET', `memberships?org_id=eq.${orgBId}`, {
      token: userAToken,
    });
    expect(leaked.status).toBe(200);
    expect(leaked.json).toEqual([]);
  });
});

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
  // PostgREST may return a single object or a one-element array for RETURNS TABLE.
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
