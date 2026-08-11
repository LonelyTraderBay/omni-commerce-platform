'use client';

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  ApiClientError,
  acceptInvite,
  createInvite,
  listInvites,
  type MembershipInvite,
} from '../../../../lib/api-client';
import {
  getStoredOrganizations,
  isForeignStorageEvent,
  SESSION_CHANGED_EVENT,
  type OrganizationRole,
  type StoredOrganization,
} from '../../../../lib/auth-session';
import { getActiveOrgId } from '../../../../lib/org-context';
import {
  Button,
  Card,
  colorBackgroundSubtle,
  colorBorderStrong,
  colorTextBody,
  colorTextHeading,
  EmptyState,
  ErrorText,
  Input,
  MutedText,
  radiusSm,
  SuccessText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../../../components/ui';

const inviteRoles: Array<{ value: OrganizationRole; label: string }> = [
  { value: 'cskh', label: 'CSKH' },
  { value: 'kho', label: 'Kho' },
  { value: 'owner', label: 'Chủ sở hữu' },
];

export default function InvitesSettingsPage() {
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<StoredOrganization[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('cskh');
  const [pendingInvites, setPendingInvites] = useState<MembershipInvite[]>([]);
  const [lastToken, setLastToken] = useState<string | null>(null);
  const [acceptToken, setAcceptToken] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshPendingInvites = useCallback(async (orgId: string) => {
    setLoadingList(true);
    try {
      const { invites } = await listInvites(orgId);
      setPendingInvites(invites);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể tải danh sách lời mời.';
      setError(message);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    function loadOrgContext(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      const orgId = getActiveOrgId();
      setActiveOrgId(orgId);
      setOrganizations(getStoredOrganizations());
      setLastToken(null);
      if (orgId) {
        void refreshPendingInvites(orgId);
      } else {
        setPendingInvites([]);
      }
    }

    loadOrgContext();
    window.addEventListener(SESSION_CHANGED_EVENT, loadOrgContext);
    window.addEventListener('storage', loadOrgContext);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, loadOrgContext);
      window.removeEventListener('storage', loadOrgContext);
    };
  }, [refreshPendingInvites]);

  const activeOrganization = useMemo(
    () => organizations.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, organizations],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccess(null);
    setError(null);
    setLastToken(null);

    if (!activeOrgId) {
      setError('Hãy chọn tổ chức trước khi tạo lời mời.');
      return;
    }

    const inviteEmail = email.trim().toLowerCase();
    if (!inviteEmail) {
      setError('Vui lòng nhập email người được mời.');
      return;
    }

    setSubmitting(true);
    try {
      const { invite, token } = await createInvite({
        orgId: activeOrgId,
        email: inviteEmail,
        role,
      });
      setPendingInvites((current) => [invite, ...current]);
      setLastToken(token);
      setEmail('');
      setSuccess(
        `Đã tạo lời mời cho ${invite.email}. Sao chép token một lần bên dưới (local/Mailpit).`,
      );
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể tạo lời mời.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccess(null);
    setError(null);

    const token = acceptToken.trim();
    if (!token) {
      setError('Vui lòng dán token lời mời.');
      return;
    }

    setAccepting(true);
    try {
      const { membership } = await acceptInvite(token);
      setAcceptToken('');
      setSuccess(
        `Đã chấp nhận lời mời — vai trò ${formatRole(membership.role)} trong tổ chức ${membership.orgId}.`,
      );
      if (activeOrgId) {
        void refreshPendingInvites(activeOrgId);
      }
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể chấp nhận lời mời.';
      setError(message);
    } finally {
      setAccepting(false);
    }
  }

  return (
    <main>
      <h1 style={{ margin: 0, fontSize: 32 }}>Lời mời thành viên</h1>
      <p style={{ color: '#475569', fontSize: 18, maxWidth: 760 }}>
        Tạo lời mời, xem danh sách đang chờ, và chấp nhận bằng token (local —
        không cần email provider). Token thô chỉ hiện một lần khi tạo.
      </p>

      <Card style={{ marginTop: 24, maxWidth: 760, padding: 24 }}>
        <h2 style={{ fontSize: 22, margin: 0 }}>Tạo lời mời</h2>
        <MutedText>
          Tổ chức:{' '}
          <strong>
            {activeOrganization?.name ?? activeOrgId ?? 'Chưa chọn tổ chức'}
          </strong>
        </MutedText>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <label style={labelStyle}>
            Email
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="nhanvien@congty.vn"
              style={{ maxWidth: 420 }}
            />
          </label>

          <label style={labelStyle}>
            Vai trò
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as OrganizationRole)
              }
              style={selectStyle}
            >
              {inviteRoles.map((inviteRole) => (
                <option key={inviteRole.value} value={inviteRole.value}>
                  {inviteRole.label}
                </option>
              ))}
            </select>
          </label>

          <Button
            type="submit"
            disabled={submitting || !activeOrgId}
            style={{ marginTop: 18 }}
          >
            {submitting ? 'Đang tạo...' : 'Tạo lời mời'}
          </Button>
        </form>

        {lastToken ? (
          <div
            role="status"
            style={{
              background: colorBackgroundSubtle,
              border: `1px solid ${colorBorderStrong}`,
              borderRadius: 10,
              marginTop: 16,
              padding: 12,
            }}
          >
            <p style={{ margin: '0 0 8px', fontWeight: 700, fontSize: 14 }}>
              Token một lần (sao chép ngay)
            </p>
            <code
              style={{
                display: 'block',
                fontSize: 12,
                overflowWrap: 'anywhere',
                wordBreak: 'break-all',
              }}
            >
              {lastToken}
            </code>
          </div>
        ) : null}

        {success ? (
          <SuccessText style={{ fontSize: 15, marginTop: 0 }}>
            {success}
          </SuccessText>
        ) : null}
        {error ? (
          <ErrorText style={{ fontSize: 15, marginTop: 0 }}>{error}</ErrorText>
        ) : null}
      </Card>

      <Card style={{ marginTop: 24, maxWidth: 760, padding: 24 }}>
        <h2 style={{ fontSize: 22, margin: 0 }}>Chấp nhận lời mời</h2>
        <MutedText>
          Đăng nhập bằng đúng email được mời, dán token, rồi chấp nhận. Không
          cần X-Org-Id.
        </MutedText>
        <form onSubmit={(event) => void handleAccept(event)}>
          <label style={labelStyle}>
            Token
            <Input
              type="text"
              value={acceptToken}
              onChange={(event) => setAcceptToken(event.target.value)}
              placeholder="Dán token 64 ký tự hex"
              style={{ maxWidth: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <Button type="submit" disabled={accepting} style={{ marginTop: 18 }}>
            {accepting ? 'Đang chấp nhận...' : 'Chấp nhận lời mời'}
          </Button>
        </form>
      </Card>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 22 }}>
          Lời mời đang chờ
          {loadingList ? ' (đang tải...)' : ''}
        </h2>

        {pendingInvites.length === 0 ? (
          <EmptyState style={{ color: '#475569', maxWidth: 760 }}>
            Không có lời mời đang chờ cho tổ chức này.
          </EmptyState>
        ) : (
          <Table style={{ minWidth: 680 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Vai trò</TableHeaderCell>
                <TableHeaderCell>Hết hạn</TableHeaderCell>
                <TableHeaderCell>Tạo lúc</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {pendingInvites.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>{invite.email}</TableCell>
                  <TableCell>{formatRole(invite.role)}</TableCell>
                  <TableCell>{formatDateTime(invite.expiresAt)}</TableCell>
                  <TableCell>{formatDateTime(invite.createdAt)}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}

function formatRole(role: OrganizationRole) {
  return inviteRoles.find((inviteRole) => inviteRole.value === role)?.label ?? role;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14,
  fontWeight: 700,
  gap: 6,
  marginTop: 16,
};

// No shared `Select` primitive exists yet, so the native <select> keeps a
// local style, matching Input's canonical border/radius/color/font/padding.
const selectStyle: CSSProperties = {
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: radiusSm,
  color: colorTextBody,
  font: 'inherit',
  maxWidth: 420,
  padding: '11px 12px',
};
