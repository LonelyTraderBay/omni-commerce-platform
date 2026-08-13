'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

import {
  ApiClientError,
  listOrganizations,
  mapOrganizationMemberships,
} from '../lib/api-client';
import {
  clearSession,
  getAccessToken,
  getStoredOrganizations,
  isForeignStorageEvent,
  saveAccessToken,
  saveOrganizations,
  SESSION_CHANGED_EVENT,
  type StoredOrganization,
} from '../lib/auth-session';
import {
  getActiveOrgId,
  resolveActiveOrgId,
  setActiveOrgId,
} from '../lib/org-context';
import { getSupabaseBrowserClient } from '../lib/supabase-browser';
import {
  isUiPreviewEnabled,
  UI_PREVIEW_ORGANIZATION,
} from '../lib/ui-preview';
import {
  Button,
  colorBackgroundCard,
  colorBorder,
  colorBorderStrong,
  colorDanger,
  colorPrimary,
  colorTextBody,
  colorTextHeading,
  colorTextMuted,
  radiusSm,
} from './ui';

// Standalone, always-first item — not part of any group (see `navGroups`
// below), matching the sidebar spec's "Tổng quan" placement.
const dashboardNavItem = { href: '/dashboard', label: 'Tổng quan', badge: '01' };

// Same 20 hrefs/labels the flat `navItems` list used to hold, reorganized
// into the sidebar's 4 named groups. Every href/label pair below is
// unchanged from the previous flat list.
const navGroups: Array<{
  label: string;
  badge: string;
  items: Array<{ href: string; label: string }>;
}> = [
  {
    label: 'Bán hàng',
    badge: 'BH',
    items: [
      { href: '/inbox', label: 'Hộp thư' },
      { href: '/orders', label: 'Đơn hàng' },
      { href: '/m', label: 'Mobile staff' },
      { href: '/cod', label: 'COD' },
      { href: '/einvoice', label: 'Hóa đơn điện tử' },
      { href: '/pnl', label: 'Lãi gộp' },
    ],
  },
  {
    label: 'Kho & Sản phẩm',
    badge: 'KHO',
    items: [
      { href: '/catalog', label: 'Sản phẩm' },
      { href: '/inventory', label: 'Kho' },
      { href: '/warehouses', label: 'Kho chi nhánh' },
      { href: '/suppliers', label: 'Nhà cung cấp' },
      { href: '/purchase-orders', label: 'PO' },
    ],
  },
  {
    label: 'Marketing & AI',
    badge: 'AI',
    items: [
      { href: '/ads', label: 'Ads' },
      { href: '/attribution', label: 'Attribution' },
      { href: '/advisor', label: 'Advisor' },
      { href: '/calendar', label: 'Lịch nội dung' },
    ],
  },
  {
    label: 'Cài đặt',
    badge: 'SET',
    items: [
      { href: '/settings/channels', label: 'Kênh' },
      { href: '/settings/billing', label: 'Thanh toán' },
      { href: '/settings', label: 'Cài đặt' },
      { href: '/settings/invites', label: 'Lời mời' },
    ],
  },
];

// Unchanged active-route matching logic, lifted out so both the standalone
// "Tổng quan" link and every grouped link share the exact same check.
function isActiveNavItem(pathname: string, href: string) {
  return (
    pathname === href || (href !== '/settings' && pathname.startsWith(`${href}/`))
  );
}

// Unchanged visual treatment (color/weight) for active vs inactive links,
// just restyled for vertical stacking instead of a wrapping horizontal row.
// `#475569` has no equivalent in `tokens.ts` (closest is `colorTextMuted` at
// `#64748b`, a different value), so it stays a plain literal, same as before.
function navLinkStyle(active: boolean): CSSProperties {
  return {
    alignItems: 'center',
    background: active ? '#dbeafe' : 'transparent',
    border: `1px solid ${active ? '#bfdbfe' : 'transparent'}`,
    borderRadius: 9,
    boxSizing: 'border-box',
    color: active ? colorPrimary : '#475569',
    display: 'flex',
    fontSize: 13,
    fontWeight: active ? 700 : 600,
    gap: 10,
    minHeight: 30,
    padding: '3px 7px',
    textDecoration: 'none',
  };
}

const groupLabelStyle: CSSProperties = {
  alignItems: 'center',
  color: colorTextMuted,
  display: 'flex',
  fontSize: 12,
  fontWeight: 700,
  gap: 8,
  letterSpacing: 0.6,
  margin: '1px 3px 4px',
  textTransform: 'uppercase',
};

const groupStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorder}`,
  borderRadius: 12,
  padding: 5,
};

const groupBadgeStyle: CSSProperties = {
  alignItems: 'center',
  background: '#f1f5f9',
  borderRadius: 6,
  color: '#475569',
  display: 'inline-flex',
  fontSize: 10,
  fontWeight: 800,
  height: 20,
  justifyContent: 'center',
  letterSpacing: 0,
  minWidth: 24,
  padding: '0 5px',
};

const navDotStyle = (active: boolean): CSSProperties => ({
  background: active ? colorPrimary : '#cbd5e1',
  borderRadius: '50%',
  flexShrink: 0,
  height: 6,
  width: 6,
});

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [organizations, setOrganizations] = useState<StoredOrganization[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const previewMode = isUiPreviewEnabled();

    function loadSession(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      const token = getAccessToken();
      if (!token && !previewMode) {
        router.replace('/login');
        return;
      }

      const storedOrganizations = getStoredOrganizations();
      setOrganizations(storedOrganizations);

      const storedActiveOrgId =
        resolveActiveOrgId(getActiveOrgId(), storedOrganizations) ?? '';
      // Only persist when the resolved value actually differs from what's
      // stored. This handler also runs on `storage` events, so re-writing the
      // same key here would bounce back to other tabs as another `storage`
      // event — a cross-tab ping-pong.
      if (storedActiveOrgId && storedActiveOrgId !== getActiveOrgId()) {
        setActiveOrgId(storedActiveOrgId);
      }
      setActiveOrgIdState(storedActiveOrgId);
    }

    loadSession();
    window.addEventListener(SESSION_CHANGED_EVENT, loadSession);
    window.addEventListener('storage', loadSession);

    let authSubscription: { unsubscribe: () => void } | undefined;
    if (previewMode) {
      return () => {
        window.removeEventListener(SESSION_CHANGED_EVENT, loadSession);
        window.removeEventListener('storage', loadSession);
      };
    }

    try {
      const subscription = getSupabaseBrowserClient().auth.onAuthStateChange(
        (event, session) => {
          if (session?.access_token) {
            saveAccessToken(session.access_token);
          } else if (event === 'SIGNED_OUT') {
            clearSession();
            router.replace('/login');
          }
        },
      );
      authSubscription = subscription.data.subscription;
    } catch {
      // The API session guard still protects the app if local Supabase config
      // is unavailable during a static/local shell render.
    }

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, loadSession);
      window.removeEventListener('storage', loadSession);
      authSubscription?.unsubscribe();
    };
  }, [router]);

  async function handleRefreshOrganizations() {
    if (isUiPreviewEnabled()) {
      setOrganizations([UI_PREVIEW_ORGANIZATION]);
      setActiveOrgIdState(UI_PREVIEW_ORGANIZATION.id);
      setMessage('Đang xem giao diện với dữ liệu demo.');
      return;
    }

    setRefreshing(true);
    setMessage(null);

    try {
      const memberships = await listOrganizations();
      const nextOrganizations = mapOrganizationMemberships(memberships);
      saveOrganizations(nextOrganizations);
      setOrganizations(nextOrganizations);
      setActiveOrgIdState(getActiveOrgId() ?? nextOrganizations[0]?.id ?? '');
      setMessage('Đã cập nhật danh sách tổ chức.');
    } catch (err) {
      const errorMessage =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể cập nhật danh sách tổ chức.';
      setMessage(errorMessage);
    } finally {
      setRefreshing(false);
    }
  }

  function handleOrgChange(orgId: string) {
    setActiveOrgId(orgId || null);
    setActiveOrgIdState(orgId);
    router.refresh();
    window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  }

  async function handleSignOut() {
    try {
      await getSupabaseBrowserClient().auth.signOut();
    } catch {
      // Always clear the local API session even if Supabase sign-out is offline.
    }
    clearSession();
    router.replace('/login');
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          background: colorBackgroundCard,
          borderRight: `1px solid ${colorBorder}`,
          boxShadow: '4px 0 18px rgba(15, 23, 42, 0.03)',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          gap: 10,
          minHeight: '100vh',
          overflowY: 'auto',
          padding: '12px 9px',
          width: 268,
        }}
      >
        <Link
          href="/dashboard"
          style={{
            color: colorTextBody,
            fontSize: 18,
            fontWeight: 800,
            padding: '0 8px',
            textDecoration: 'none',
          }}
        >
          Omni Commerce
        </Link>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Link
            href={dashboardNavItem.href}
            style={navLinkStyle(isActiveNavItem(pathname, dashboardNavItem.href))}
          >
            <span
              aria-hidden="true"
              style={groupBadgeStyle}
            >
              {dashboardNavItem.badge}
            </span>
            <span>{dashboardNavItem.label}</span>
          </Link>

          {navGroups.map((group) => (
            <div
              key={group.label}
              style={groupStyle}
            >
              <div style={groupLabelStyle}>
                <span aria-hidden="true" style={groupBadgeStyle}>
                  {group.badge}
                </span>
                <span>{group.label}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {group.items.map((item) => {
                  const active = isActiveNavItem(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      style={navLinkStyle(active)}
                    >
                      <span aria-hidden="true" style={navDotStyle(active)} />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }}>
        <header
          style={{
            alignItems: 'center',
            background: colorBackgroundCard,
            borderBottom: `1px solid ${colorBorder}`,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            justifyContent: 'flex-end',
            padding: '16px 32px',
          }}
        >
          <label
            style={{
              color: colorTextHeading,
              display: 'flex',
              flexDirection: 'column',
              fontSize: 12,
              fontWeight: 700,
              gap: 4,
            }}
          >
            Tổ chức đang dùng
            <select
              value={activeOrgId}
              onChange={(event) => handleOrgChange(event.target.value)}
              style={{
                border: `1px solid ${colorBorderStrong}`,
                borderRadius: radiusSm,
                color: colorTextBody,
                minWidth: 220,
                padding: '8px 10px',
              }}
            >
              {organizations.length === 0 ? (
                <option value="">Chưa có tổ chức</option>
              ) : null}
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                  {org.role ? ` (${org.role})` : ''}
                </option>
              ))}
            </select>
          </label>

          {isUiPreviewEnabled() ? (
            <span
              style={{
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: radiusSm,
                color: '#1d4ed8',
                fontSize: 13,
                fontWeight: 700,
                padding: '9px 12px',
              }}
            >
              Chế độ xem UI · dữ liệu demo
            </span>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => void handleRefreshOrganizations()}
                disabled={refreshing}
              >
                {refreshing ? 'Đang tải...' : 'Tải tổ chức'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleSignOut()}
                style={{ color: colorDanger }}
              >
                Đăng xuất
              </Button>
            </>
          )}
        </header>

        {message ? (
          <p
            role="status"
            style={{
              background: '#eff6ff',
              color: '#1d4ed8',
              margin: 0,
              padding: '10px 32px',
            }}
          >
            {message}
          </p>
        ) : null}

        <div style={{ padding: '32px' }}>{children}</div>
      </div>
    </div>
  );
}
