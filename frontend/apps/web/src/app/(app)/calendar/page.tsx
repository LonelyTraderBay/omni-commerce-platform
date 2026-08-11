'use client';

import { type CSSProperties, useCallback, useEffect, useState } from 'react';

import {
  ApiClientError,
  createContentCalendarItem,
  deleteContentCalendarItem,
  listContentCalendarItems,
  updateContentCalendarItem,
  type ContentCalendarItem,
  type ContentCalendarStatus,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorBorderStrong,
  colorDanger,
  colorSuccess,
  colorTextBody,
  colorTextHeading,
  EmptyState,
  Input,
  MutedText,
  Textarea,
} from '../../../components/ui';

const statusOptions: Array<{ value: ContentCalendarStatus | ''; label: string }> = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'idea', label: 'Ý tưởng' },
  { value: 'scheduled', label: 'Đã lên lịch' },
  { value: 'posted', label: 'Đã đăng thủ công' },
  { value: 'cancelled', label: 'Đã huỷ' },
];

export default function CalendarPage() {
  const [items, setItems] = useState<ContentCalendarItem[]>([]);
  const [status, setStatus] = useState<ContentCalendarStatus | ''>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [plannedAt, setPlannedAt] = useState(defaultLocalDateTime());
  const [channelHint, setChannelHint] = useState('facebook');
  const [autoPostEnabled, setAutoPostEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setItems(await listContentCalendarItems(status || undefined));
    } catch (err) {
      setItems([]);
      setError(getApiErrorMessage(err, 'Không thể tải lịch nội dung.'));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadItems();
    }

    void loadItems();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadItems]);

  async function handleCreate() {
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const item = await createContentCalendarItem({
        title,
        body: body.trim() || null,
        plannedAt: new Date(plannedAt).toISOString(),
        status: 'scheduled',
        channelHint: channelHint.trim() || null,
        autoPostEnabled,
      });
      setItems((current) => [item, ...current]);
      setTitle('');
      setBody('');
      setAutoPostEnabled(false);
      setMessage('Đã thêm lịch nội dung. Auto-post chỉ được lưu cờ, chưa gửi Meta.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tạo lịch nội dung.'));
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(
    item: ContentCalendarItem,
    nextStatus: ContentCalendarStatus,
  ) {
    setBusyItemId(item.id);
    setError(null);
    setMessage(null);

    try {
      const updated = await updateContentCalendarItem(item.id, {
        status: nextStatus,
      });
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? updated : entry)),
      );
      setMessage(`Đã chuyển "${item.title}" sang ${formatStatus(nextStatus)}.`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể cập nhật lịch nội dung.'));
    } finally {
      setBusyItemId(null);
    }
  }

  async function removeItem(item: ContentCalendarItem) {
    setBusyItemId(item.id);
    setError(null);
    setMessage(null);

    try {
      await deleteContentCalendarItem(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setMessage(`Đã xoá "${item.title}".`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể xoá lịch nội dung.'));
    } finally {
      setBusyItemId(null);
    }
  }

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Lịch nội dung</h1>
          <p style={descriptionStyle}>
            Lên kế hoạch bài bán hàng theo kênh. Auto-post mặc định tắt; nếu bật
            thì hệ thống chỉ lưu cờ để owner kiểm tra, chưa đăng Meta tự động.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void loadItems()}
          disabled={loading}
        >
          {loading ? 'Đang tải...' : 'Tải lại'}
        </Button>
      </header>

      <p role="status" style={warningStyle}>
        Plan G không triển khai Meta auto-post. Chủ shop vẫn phải đăng hoặc duyệt
        thủ công trên kênh phù hợp.
      </p>

      {error ? (
        <p role="alert" style={alertStyle}>
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" style={successStyle}>
          {message}
        </p>
      ) : null}

      <Card title="Tạo lịch mới" style={{ marginTop: 24 }}>
        <div style={formGridStyle}>
          <label style={labelStyle}>
            Tiêu đề
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={300}
              placeholder="Ví dụ: Flash sale cuối tuần"
            />
          </label>
          <label style={labelStyle}>
            Thời gian dự kiến
            <Input
              value={plannedAt}
              onChange={(event) => setPlannedAt(event.target.value)}
              type="datetime-local"
            />
          </label>
          <label style={labelStyle}>
            Kênh gợi ý
            <Input
              value={channelHint}
              onChange={(event) => setChannelHint(event.target.value)}
              maxLength={120}
              placeholder="facebook, instagram, zalo..."
            />
          </label>
          <label style={{ ...labelStyle, justifyContent: 'end' }}>
            <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
              <input
                checked={autoPostEnabled}
                onChange={(event) => setAutoPostEnabled(event.target.checked)}
                type="checkbox"
              />
              Lưu cờ auto-post
            </span>
          </label>
        </div>
        <label style={labelStyle}>
          Nội dung nháp
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={10000}
            placeholder="Nội dung bài viết..."
            rows={5}
          />
        </label>
        <Button
          onClick={() => void handleCreate()}
          disabled={saving || title.trim().length === 0}
        >
          {saving ? 'Đang lưu...' : 'Thêm vào lịch'}
        </Button>
      </Card>

      <Card
        style={{
          alignItems: 'end',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          justifyContent: 'space-between',
          marginTop: 24,
        }}
      >
        <label style={labelStyle}>
          Lọc trạng thái
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as ContentCalendarStatus | '')
            }
            style={selectStyle}
          >
            {statusOptions.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <Card style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText style={{ fontSize: 14 }}>Đang tải lịch nội dung...</MutedText>
        ) : items.length === 0 ? (
          <EmptyState>Chưa có nội dung phù hợp bộ lọc.</EmptyState>
        ) : (
          <div style={itemGridStyle}>
            {items.map((item) => (
              <Card key={item.id} style={itemCardStyle}>
                <div style={cardHeaderStyle}>
                  <div>
                    <h3 style={{ margin: 0 }}>{item.title}</h3>
                    <MutedText style={{ fontSize: 14 }}>
                      {formatDateTime(item.plannedAt)} ·{' '}
                      {item.channelHint ?? 'Chưa chọn kênh'}
                    </MutedText>
                  </div>
                  <strong>{formatStatus(item.status)}</strong>
                </div>
                <p style={bodyStyle}>{item.body || 'Chưa có nội dung nháp.'}</p>
                {item.autoPostEnabled ? (
                  <p style={warningStyle}>
                    Auto-post đang bật cờ lưu trữ, chưa có tác vụ đăng tự động.
                  </p>
                ) : null}
                <div style={actionRowStyle}>
                  {(['idea', 'scheduled', 'posted', 'cancelled'] as const).map(
                    (nextStatus) =>
                      nextStatus !== item.status ? (
                        <Button
                          key={nextStatus}
                          variant="link"
                          onClick={() => void updateStatus(item, nextStatus)}
                          disabled={busyItemId === item.id}
                        >
                          {formatStatus(nextStatus)}
                        </Button>
                      ) : null,
                  )}
                  <Button
                    variant="danger"
                    onClick={() => void removeItem(item)}
                    disabled={busyItemId === item.id}
                  >
                    Xoá
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}

function defaultLocalDateTime() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return date.toISOString().slice(0, 16);
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function formatStatus(status: ContentCalendarStatus) {
  return statusOptions.find((option) => option.value === status)?.label ?? status;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
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
  maxWidth: 820,
};

const formGridStyle: CSSProperties = {
  display: 'grid',
  gap: 14,
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
};

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  fontWeight: 700,
  gap: 6,
  marginBottom: 12,
};

// No shared `Select` primitive exists yet, so the native <select> keeps a
// local style with only the border/text color literals swapped for their
// tokens (radius stays a raw 8, matching the native-<select> precedent in
// orders/page.tsx and catalog/page.tsx, even though it numerically equals
// `radiusSm` here).
const selectStyle: CSSProperties = {
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: 8,
  color: colorTextBody,
  font: 'inherit',
  padding: '10px 12px',
};

const itemGridStyle: CSSProperties = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
};

const itemCardStyle: CSSProperties = {
  padding: 16,
};

const cardHeaderStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  gap: 12,
  justifyContent: 'space-between',
};

const bodyStyle: CSSProperties = {
  color: colorTextBody,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
};

const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
};

// Tinted danger banner — kept bespoke like the other pages in this wave;
// only `color` has an exact token match (folded in via `alertStyle` below).
const alertStyle: CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: 12,
  color: colorDanger,
  marginTop: 16,
  padding: 16,
};

// Tinted success banner — same bespoke treatment as `alertStyle`.
const successStyle: CSSProperties = {
  background: '#f0fdf4',
  border: '1px solid #bbf7d0',
  borderRadius: 12,
  color: colorSuccess,
  marginTop: 16,
  padding: 16,
};

// Tinted warning banner used for the Meta auto-post disclosure (both the
// page-level notice and the per-item flag notice). Uses the darker
// `#92400e` amber that tokens.ts documents as deliberately NOT folded into
// `colorWarning` — this is the highest-prominence treatment already
// available (tinted background + border), so it is left fully unchanged:
// same colors, same wording, same structure, per this wave's explicit
// instruction not to weaken/soften/reposition the auto-post warning copy.
const warningStyle: CSSProperties = {
  background: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: 12,
  color: '#92400e',
  marginTop: 16,
  padding: 16,
};
