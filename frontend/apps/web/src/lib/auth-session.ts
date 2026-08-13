import {
  ACTIVE_ORG_ID_STORAGE_KEY,
  getActiveOrgId,
  resolveActiveOrgId,
  setActiveOrgId,
} from './org-context';
import {
  isUiPreviewEnabled,
  UI_PREVIEW_ACCESS_TOKEN,
  UI_PREVIEW_ORGANIZATION,
} from './ui-preview';

export const ACCESS_TOKEN_STORAGE_KEY = 'omni.accessToken';
export const ORGANIZATIONS_STORAGE_KEY = 'omni.organizations';
export const SESSION_CHANGED_EVENT = 'omni:session-changed';

// The localStorage keys that represent the signed-in session/org context.
// A cross-tab `storage` event that doesn't touch one of these keys is not a
// session change and must not trigger a data reload.
export const SESSION_STORAGE_KEYS: readonly string[] = [
  ACCESS_TOKEN_STORAGE_KEY,
  ORGANIZATIONS_STORAGE_KEY,
  ACTIVE_ORG_ID_STORAGE_KEY,
];

/**
 * True when `event` is a cross-tab `storage` event whose key is NOT one of the
 * app's own session keys — i.e. an unrelated localStorage write that a
 * session-sync handler should ignore.
 *
 * Session-sync effects register the same callback for both the in-app
 * `SESSION_CHANGED_EVENT` (a plain `Event`, never foreign) and the browser
 * `storage` event. A `null` key means `localStorage.clear()` and is treated as
 * relevant (not foreign) so a full sign-out still refreshes.
 */
export function isForeignStorageEvent(event: Event): boolean {
  if (!(event instanceof StorageEvent)) {
    return false;
  }
  if (event.key === null) {
    return false;
  }
  return !SESSION_STORAGE_KEYS.includes(event.key);
}

export type OrganizationRole = 'owner' | 'cskh' | 'kho';

export type StoredOrganization = {
  id: string;
  name: string;
  slug?: string;
  role?: OrganizationRole;
};

export type StoredSession = {
  accessToken: string;
  organizations: StoredOrganization[];
  activeOrgId: string | null;
};

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (isUiPreviewEnabled()) {
    return UI_PREVIEW_ACCESS_TOKEN;
  }

  return (
    window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? null
  );
}

export function getStoredOrganizations(): StoredOrganization[] {
  if (typeof window === 'undefined') {
    return [];
  }

  if (isUiPreviewEnabled()) {
    return [UI_PREVIEW_ORGANIZATION];
  }

  const raw = window.localStorage.getItem(ORGANIZATIONS_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeOrganizations(parsed);
  } catch {
    return [];
  }
}

export function getStoredSession(): StoredSession | null {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return null;
  }

  return {
    accessToken,
    organizations: getStoredOrganizations(),
    activeOrgId: getActiveOrgId(),
  };
}

export function saveSession(input: {
  accessToken: string;
  organizations: StoredOrganization[];
  activeOrgId?: string | null;
}): StoredSession {
  const organizations = normalizeOrganizations(input.organizations);
  const preferredActiveOrgId = input.activeOrgId ?? getActiveOrgId();
  const activeOrgId = resolveActiveOrgId(preferredActiveOrgId, organizations);

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, input.accessToken);
    window.localStorage.setItem(
      ORGANIZATIONS_STORAGE_KEY,
      JSON.stringify(organizations),
    );
  }

  setActiveOrgId(activeOrgId);
  notifySessionChanged();

  return {
    accessToken: input.accessToken,
    organizations,
    activeOrgId,
  };
}

export function clearSession(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(ORGANIZATIONS_STORAGE_KEY);
  }

  setActiveOrgId(null);
  notifySessionChanged();
}

export function saveAccessToken(accessToken: string): void {
  const token = accessToken.trim();
  if (!token || typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
  notifySessionChanged();
}

export function saveOrganizations(organizations: StoredOrganization[]): void {
  const normalized = normalizeOrganizations(organizations);

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(
      ORGANIZATIONS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  }

  setActiveOrgId(resolveActiveOrgId(getActiveOrgId(), normalized));

  notifySessionChanged();
}

export function normalizeOrganizations(input: unknown[]): StoredOrganization[] {
  const organizations = new Map<string, StoredOrganization>();

  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const row = item as Partial<StoredOrganization>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) {
      continue;
    }

    const name =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : id;
    const slug =
      typeof row.slug === 'string' && row.slug.trim()
        ? row.slug.trim()
        : undefined;
    const role = isOrganizationRole(row.role) ? row.role : undefined;

    organizations.set(id, {
      id,
      name,
      ...(slug ? { slug } : {}),
      ...(role ? { role } : {}),
    });
  }

  return [...organizations.values()];
}

function isOrganizationRole(role: unknown): role is OrganizationRole {
  return role === 'owner' || role === 'cskh' || role === 'kho';
}

function notifySessionChanged(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}
