'use client';

import Link from 'next/link';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiClientError,
  listChannels,
  listLowStock,
  listOrders,
  type CatalogVariant,
  type ChannelConnection,
  type Order,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorBackgroundCard,
  colorBackgroundSubtle,
  colorBorder,
  colorDanger,
  colorPrimary,
  colorTextBody,
  EmptyState,
  ErrorText,
  MutedText,
  radiusMd,
} from '../../../components/ui';

type DashboardState = {
  orders: Order[];
  channels: ChannelConnection[];
  lowStockVariants: CatalogVariant[];
  lowStockThreshold: number;
};

export default function DashboardPage() {
  const [state, setState] = useState<DashboardState>({
    orders: [],
    channels: [],
    lowStockVariants: [],
    lowStockThreshold: 5,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  // Bumped on every load; a resolved response is applied only while it is
  // still the latest, so an older org's in-flight load can't overwrite the
  // current org's data after a switch.
  const loadSeqRef = useRef(0);

  const loadDashboard = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const [orders, channels, lowStock] = await Promise.all([
        listOrders(),
        listChannels(),
        listLowStock(),
      ]);

      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setState({
        orders,
        channels,
        lowStockVariants: lowStock.variants,
        lowStockThreshold: lowStock.threshold,
      });
      setLastUpdatedAt(new Date());
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setError(getApiErrorMessage(err, 'Không thể tải bảng điều khiển.'));
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadDashboard();
    }

    void loadDashboard();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadDashboard]);

  const newOrders = state.orders.filter((order) => order.status === 'draft');
  const channelIssues = state.channels.filter(
    (channel) => channel.status === 'needs_reauth' || channel.status === 'revoked',
  );
  const needsAttention =
    newOrders.length + state.lowStockVariants.length + channelIssues.length;

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Bảng điều khiển</h1>
          <p style={descriptionStyle}>
            Tóm tắt đơn mới, tồn kho thấp và các mục cần xử lý của tổ chức đang
            chọn.
          </p>
          {lastUpdatedAt ? (
            <MutedText>
              Cập nhật lần cuối: {formatDateTime(lastUpdatedAt.toISOString())}
            </MutedText>
          ) : null}
        </div>
        <Button
          variant="secondary"
          onClick={() => void loadDashboard()}
          disabled={loading}
        >
          {loading ? 'Đang tải...' : 'Tải lại'}
        </Button>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <section style={gridStyle}>
        <MetricCard
          label="Đơn mới"
          value={newOrders.length}
          href="/orders?status=draft"
        />
        <MetricCard
          label="Sắp hết hàng"
          value={state.lowStockVariants.length}
          href="/inventory"
        />
        <MetricCard
          label="Cần chú ý"
          value={needsAttention}
          href="/settings/channels"
        />
      </section>

      <Card title="Việc cần làm" style={{ marginTop: 28 }}>
        {loading ? (
          <MutedText>Đang tải dữ liệu...</MutedText>
        ) : needsAttention === 0 ? (
          <EmptyState>Chưa có mục cần chú ý.</EmptyState>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {newOrders.slice(0, 5).map((order) => (
              <Link key={order.id} href="/orders" style={itemLinkStyle}>
                Xác nhận đơn {shortId(order.id)} -{' '}
                {order.customerName ?? 'Khách chưa đặt tên'} -{' '}
                {formatMoney(order.totalVnd)}
              </Link>
            ))}
            {state.lowStockVariants.slice(0, 5).map((variant) => (
              <Link
                key={variant.id}
                href="/inventory"
                style={{ ...itemLinkStyle, color: '#92400e' }}
              >
                Tồn kho thấp: {variant.sku} / {variant.title} còn{' '}
                {variant.stockQty} (ngưỡng {state.lowStockThreshold})
              </Link>
            ))}
            {channelIssues.map((channel) => (
              <Link
                key={channel.id}
                href="/settings/channels"
                style={{ ...itemLinkStyle, color: colorDanger }}
              >
                Kênh {channel.externalPageId} đang ở trạng thái {channel.status}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}

function MetricCard({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link href={href} style={metricCardStyle}>
      <span style={metricValueStyle}>{value}</span>
      <span style={metricLabelStyle}>{label}</span>
    </Link>
  );
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatMoney(value: string) {
  return new Intl.NumberFormat('vi-VN', {
    currency: 'VND',
    style: 'currency',
  }).format(Number(value));
}

const headerStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  gap: 16,
  justifyContent: 'space-between',
};

const descriptionStyle: CSSProperties = {
  color: '#475569',
  fontSize: 18,
  maxWidth: 760,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  marginTop: 28,
};

const metricCardStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorder}`,
  borderRadius: radiusMd,
  color: colorTextBody,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 20,
  textDecoration: 'none',
};

const metricValueStyle: CSSProperties = {
  fontSize: 36,
  fontWeight: 900,
};

const metricLabelStyle: CSSProperties = {
  color: '#475569',
  fontSize: 16,
  fontWeight: 700,
};

const itemLinkStyle: CSSProperties = {
  background: colorBackgroundSubtle,
  border: `1px solid ${colorBorder}`,
  borderRadius: 10,
  color: colorPrimary,
  fontWeight: 700,
  padding: 12,
  textDecoration: 'none',
};
