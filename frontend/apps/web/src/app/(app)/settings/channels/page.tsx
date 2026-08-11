'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  type FormEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  ApiClientError,
  connectZalo,
  getMetaOAuthUrl,
  listChannels,
  revokeChannel,
  type ChannelConnection,
} from '../../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../../lib/auth-session';
import {
  Button,
  colorBorder,
  colorDanger,
  colorTextHeading,
  ErrorText,
  Input,
  MutedText,
  radiusMd,
  SuccessText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../../../components/ui';

const PROVIDER_LABELS: Record<string, string> = {
  meta_page: 'Facebook Page',
  meta_ig: 'Instagram',
  zalo_oa: 'Zalo OA',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Đang hoạt động',
  needs_reauth: 'Cần đăng nhập lại',
  revoked: 'Đã thu hồi',
};

function formatProvider(provider: string) {
  return PROVIDER_LABELS[provider] ?? provider;
}

function formatStatus(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function ChannelsSettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [channels, setChannels] = useState<ChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [zaloAccessToken, setZaloAccessToken] = useState('');
  const [zaloDisplayName, setZaloDisplayName] = useState('');
  const [zaloOaId, setZaloOaId] = useState('');
  const [zaloSaving, setZaloSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const zaloSectionRef = useRef<HTMLElement>(null);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await listChannels();
      setChannels(data);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể tải danh sách kênh.';
      setError(message);
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadChannels();
    }

    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadChannels]);

  useEffect(() => {
    const oauthError = searchParams.get('oauth_error');
    const oauthSuccess = searchParams.get('oauth_success');

    if (oauthError) {
      setError(oauthError);
      setSuccess(null);
    } else if (oauthSuccess) {
      setSuccess('Đã kết nối kênh Meta thành công.');
      setError(null);
      void loadChannels();
    } else {
      return;
    }

    router.replace('/settings/channels');
  }, [loadChannels, router, searchParams]);

  async function handleConnect() {
    setConnecting(true);
    setError(null);

    try {
      const { url } = await getMetaOAuthUrl();
      window.location.assign(url);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể bắt đầu kết nối Meta.';
      setError(message);
      setConnecting(false);
    }
  }

  async function handleZaloConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setZaloSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await connectZalo({
        oaId: zaloOaId,
        accessToken: zaloAccessToken,
        displayName: zaloDisplayName.trim() || undefined,
      });
      setSuccess('Đã kết nối Zalo OA thành công.');
      setZaloAccessToken('');
      setZaloDisplayName('');
      setZaloOaId('');
      await loadChannels();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể kết nối Zalo OA.';
      setError(message);
    } finally {
      setZaloSaving(false);
    }
  }

  async function handleDisconnect(channel: ChannelConnection) {
    if (
      !window.confirm(
        `Ngắt kết nối ${formatProvider(channel.provider)} (${channel.externalPageId})? Bot sẽ ngừng nhận/gửi tin nhắn qua kênh này cho đến khi kết nối lại.`,
      )
    ) {
      return;
    }
    setDisconnecting(channel.id);
    setError(null);
    setSuccess(null);
    try {
      await revokeChannel(channel.id);
      setSuccess(`Đã ngắt kết nối ${formatProvider(channel.provider)}.`);
      await loadChannels();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Không thể ngắt kết nối kênh.',
      );
    } finally {
      setDisconnecting(null);
    }
  }

  function handleZaloReconnectPrefill(channel: ChannelConnection) {
    setZaloOaId(channel.externalPageId);
    zaloSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <main>
      <h1 style={{ margin: 0, fontSize: 32 }}>Kết nối kênh</h1>
      <p style={{ color: '#475569', fontSize: 18, maxWidth: 720 }}>
        Liên kết trang Facebook và tài khoản Instagram Business để nhận tin
        nhắn qua Omni Commerce. Token truy cập được lưu an toàn trên máy chủ
        và không hiển thị tại đây.
      </p>

      <div style={{ marginTop: 24 }}>
        <Button onClick={() => void handleConnect()} disabled={connecting}>
          {connecting ? 'Đang chuyển hướng…' : 'Kết nối Facebook / Instagram'}
        </Button>
      </div>

      <section
        ref={zaloSectionRef}
        style={{
          border: `1px solid ${colorBorder}`,
          borderRadius: radiusMd,
          marginTop: 24,
          maxWidth: 720,
          padding: 20,
        }}
      >
        <h2 style={{ fontSize: 22, margin: 0 }}>Kết nối Zalo OA</h2>
        <MutedText style={{ marginBottom: 16 }}>
          Nhập OA ID và access token hiện có. Token được mã hóa trên máy chủ và
          không hiển thị lại trong giao diện.
        </MutedText>
        <form onSubmit={(event) => void handleZaloConnect(event)}>
          <label style={formLabelStyle}>
            OA ID
            <Input
              required
              value={zaloOaId}
              onChange={(event) => setZaloOaId(event.target.value)}
              style={formInputStyle}
              placeholder="Ví dụ: 123456789"
            />
          </label>
          <label style={formLabelStyle}>
            Tên hiển thị (tuỳ chọn)
            <Input
              value={zaloDisplayName}
              onChange={(event) => setZaloDisplayName(event.target.value)}
              style={formInputStyle}
              placeholder="Zalo Shop"
            />
          </label>
          <label style={formLabelStyle}>
            Access token
            <Input
              required
              type="password"
              value={zaloAccessToken}
              onChange={(event) => setZaloAccessToken(event.target.value)}
              style={formInputStyle}
              placeholder="Nhập token Zalo OA"
            />
          </label>
          <Button type="submit" disabled={zaloSaving}>
            {zaloSaving ? 'Đang lưu…' : 'Lưu Zalo OA'}
          </Button>
        </form>
      </section>

      {success ? <SuccessText>{success}</SuccessText> : null}

      {error ? <ErrorText>{error}</ErrorText> : null}

      <section style={{ marginTop: 40 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 22 }}>Kênh đã nối</h2>

        {loading ? (
          <MutedText>Đang tải…</MutedText>
        ) : channels.length === 0 ? (
          <MutedText>Chưa kết nối trang nào</MutedText>
        ) : (
          <Table style={{ minWidth: 560 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Nhà cung cấp</TableHeaderCell>
                <TableHeaderCell>Page ID</TableHeaderCell>
                <TableHeaderCell>Trạng thái</TableHeaderCell>
                <TableHeaderCell>Hành động</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {channels.map((channel) => {
                const needsReconnect =
                  channel.status === 'needs_reauth' ||
                  channel.status === 'revoked';
                const isDisconnecting = disconnecting === channel.id;

                return (
                  <TableRow key={channel.id}>
                    <TableCell>{formatProvider(channel.provider)}</TableCell>
                    <TableCell>{channel.externalPageId}</TableCell>
                    <TableCell>{formatStatus(channel.status)}</TableCell>
                    <TableCell>
                      <div
                        style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
                      >
                        {needsReconnect &&
                        (channel.provider === 'meta_page' ||
                          channel.provider === 'meta_ig') ? (
                          <Button
                            onClick={() => void handleConnect()}
                            disabled={connecting}
                          >
                            Kết nối lại
                          </Button>
                        ) : null}
                        {needsReconnect && channel.provider === 'zalo_oa' ? (
                          <Button
                            onClick={() => handleZaloReconnectPrefill(channel)}
                          >
                            Dán token mới
                          </Button>
                        ) : null}
                        <Button
                          onClick={() => void handleDisconnect(channel)}
                          disabled={isDisconnecting}
                          style={{ background: colorDanger }}
                        >
                          {isDisconnecting ? 'Đang ngắt...' : 'Ngắt kết nối'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}

const formLabelStyle = {
  color: colorTextHeading,
  display: 'block',
  fontSize: 14,
  fontWeight: 700,
  marginBottom: 12,
};

const formInputStyle = {
  display: 'block',
  fontSize: 16,
  marginTop: 6,
  width: '100%',
};

export default function ChannelsSettingsPage() {
  return (
    <Suspense
      fallback={
        <main>
          <MutedText>Đang tải…</MutedText>
        </main>
      }
    >
      <ChannelsSettingsContent />
    </Suspense>
  );
}
