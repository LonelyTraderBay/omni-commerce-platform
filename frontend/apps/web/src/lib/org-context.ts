export const ACTIVE_ORG_ID_STORAGE_KEY = 'omni.activeOrgId';

let activeOrgId: string | null = null;

export function getActiveOrgId(): string | null {
  if (typeof window === 'undefined') {
    return activeOrgId;
  }

  return window.localStorage.getItem(ACTIVE_ORG_ID_STORAGE_KEY);
}

export function setActiveOrgId(orgId: string | null): void {
  activeOrgId = orgId;

  if (typeof window === 'undefined') {
    return;
  }

  if (orgId === null) {
    window.localStorage.removeItem(ACTIVE_ORG_ID_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(ACTIVE_ORG_ID_STORAGE_KEY, orgId);
}

export function buildApiHeaders(input: {
  accessToken: string;
  orgId: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    'X-Org-Id': input.orgId,
    'Content-Type': 'application/json',
  };
}

/**
 * Picks the org id that should be treated as active given a candidate
 * (typically whatever was last persisted to storage) and the current list of
 * organizations the user actually belongs to.
 *
 * The candidate is only trusted when it still refers to a membership in
 * `organizations`. Otherwise callers must fall back to the first known
 * organization (or `null` when there are none) rather than keep sending a
 * stale/foreign org id to the API, which the server will reject with 403/400
 * even though valid organizations are available.
 */
export function resolveActiveOrgId(
  candidateOrgId: string | null | undefined,
  organizations: ReadonlyArray<{ id: string }>,
): string | null {
  if (
    candidateOrgId &&
    organizations.some((org) => org.id === candidateOrgId)
  ) {
    return candidateOrgId;
  }

  return organizations[0]?.id ?? null;
}
