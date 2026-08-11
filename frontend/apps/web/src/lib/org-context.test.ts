import { describe, expect, it } from 'vitest';
import { buildApiHeaders, resolveActiveOrgId } from './org-context';

describe('buildApiHeaders', () => {
  it('injects Authorization and X-Org-Id', () => {
    const h = buildApiHeaders({
      accessToken: 'tok',
      orgId: '11111111-1111-1111-1111-111111111111',
    });

    expect(h.Authorization).toBe('Bearer tok');
    expect(h['X-Org-Id']).toBe('11111111-1111-1111-1111-111111111111');
  });
});

describe('resolveActiveOrgId', () => {
  const organizations = [{ id: 'org-a' }, { id: 'org-b' }];

  it('keeps the candidate when it is a current membership', () => {
    expect(resolveActiveOrgId('org-b', organizations)).toBe('org-b');
  });

  it('falls back to the first organization when the candidate is stale/foreign', () => {
    // Regression: a user who was removed from an org, switched orgs, or has
    // any leftover localStorage from a previous session must not keep
    // sending an org id the API will reject with 403/400 — the app should
    // self-heal to a real membership instead.
    expect(resolveActiveOrgId('org-not-a-member', organizations)).toBe(
      'org-a',
    );
  });

  it('falls back to the first organization when the candidate is null/undefined', () => {
    expect(resolveActiveOrgId(null, organizations)).toBe('org-a');
    expect(resolveActiveOrgId(undefined, organizations)).toBe('org-a');
  });

  it('falls back to the first organization when the candidate is empty', () => {
    expect(resolveActiveOrgId('', organizations)).toBe('org-a');
  });

  it('returns null when there are no organizations at all', () => {
    expect(resolveActiveOrgId('org-a', [])).toBeNull();
    expect(resolveActiveOrgId(null, [])).toBeNull();
  });
});
