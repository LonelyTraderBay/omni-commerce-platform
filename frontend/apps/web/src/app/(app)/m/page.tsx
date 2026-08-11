'use client';

import { type CSSProperties, useCallback, useEffect, useState } from 'react';

import {
  ApiClientError,
  createShipment,
  listInboxConversations,
  listOrders,
  type InboxConversation,
  type Order,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorPrimaryText,
  colorTextMuted,
  ErrorText,
  MutedText,
  SuccessText,
} from '../../../components/ui';

export default function StaffMobilePage() {
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (event?: Event) => {
    if (event && isForeignStorageEvent(event)) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextConversations, nextOrders] = await Promise.all([
        listInboxConversations(),
        listOrders('confirmed'),
      ]);
      setConversations(nextConversations.slice(0, 20));
      setOrders(nextOrders.slice(0, 20));
    } catch (err) {
      setError(apiError(err, 'Không thể tải mobile inbox/ship.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(SESSION_CHANGED_EVENT, load);
    window.addEventListener('storage', load);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, load);
      window.removeEventListener('storage', load);
    };
  }, [load]);

  async function handleShip(order: Order) {
    setBusyOrderId(order.id);
    setMessage(null);
    setError(null);
    try {
      const result = await createShipment({ orderId: order.id, provider: 'manual' });
      setMessage(`Đã tạo vận đơn ${result.shipment.trackingCode ?? ''}.`);
      await load();
    } catch (err) {
      setError(apiError(err, 'Không thể tạo vận đơn.'));
    } finally {
      setBusyOrderId(null);
    }
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Mobile staff</h1>
          <MutedText>Màn hình mỏng cho CSKH/kho: inbox mới và nút ship đơn confirmed.</MutedText>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Đang tải...' : 'Tải lại'}
        </Button>
      </header>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText style={{ color: '#047857' }}>{message}</SuccessText> : null}

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Inbox</h2>
        {conversations.length === 0 ? (
          <MutedText>Không có hội thoại gần đây.</MutedText>
        ) : (
          <div style={cardListStyle}>
            {conversations.map((conversation) => (
              <Card key={conversation.id} style={cardStyle}>
                <strong>{conversation.contact?.displayName ?? 'Khách chưa tên'}</strong>
                <span style={mutedStyle}>{conversation.channel} · {conversation.status}</span>
                <span style={mutedStyle}>{conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString('vi-VN') : 'Chưa có tin'}</span>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Đơn chờ ship</h2>
        {orders.length === 0 ? (
          <MutedText>Không có đơn confirmed.</MutedText>
        ) : (
          <div style={cardListStyle}>
            {orders.map((order) => (
              <Card key={order.id} style={cardStyle}>
                <strong>{order.customerName ?? order.id.slice(0, 8)}</strong>
                <span style={mutedStyle}>{formatVnd(order.totalVnd)} · {order.phoneE164 ?? 'no phone'}</span>
                <Button
                  variant="secondary"
                  disabled={busyOrderId === order.id}
                  onClick={() => void handleShip(order)}
                  style={shipButtonStyle}
                >
                  {busyOrderId === order.id ? 'Đang ship...' : 'Tạo vận đơn'}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function apiError(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function formatVnd(value: string) {
  return `${value.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

const pageStyle: CSSProperties = { margin: '0 auto', maxWidth: 560, padding: 16 };
const headerStyle: CSSProperties = { alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between' };
const sectionStyle: CSSProperties = { marginTop: 24 };
const sectionTitleStyle: CSSProperties = { fontSize: 20, margin: '0 0 12px' };
const cardListStyle: CSSProperties = { display: 'grid', gap: 12 };
const cardStyle: CSSProperties = { display: 'grid', gap: 6, padding: 14 };
const shipButtonStyle: CSSProperties = { background: '#0f766e', color: colorPrimaryText, justifySelf: 'start' };
const mutedStyle: CSSProperties = { color: colorTextMuted };
