'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiClientError,
  getAttributionSummary,
  type AttributionSummary,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorDanger,
  colorTextBody,
  colorTextHeading,
  colorTextMuted,
  EmptyState,
  Input,
  MutedText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../../components/ui';

type DateRange = {
  from: string;
  to: string;
};

export default function AttributionPage() {
  const [range, setRange] = useState<DateRange>(() => defaultRange());
  const [summary, setSummary] = useState<AttributionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every load; a resolved response is applied only while it is
  // still the latest, so an older org's (or date range's) in-flight load can't
  // overwrite the current data after a switch.
  const loadSeqRef = useRef(0);

  const loadSummary = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const nextSummary = await getAttributionSummary(range);
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setSummary(nextSummary);
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setSummary(null);
      setError(getApiErrorMessage(err, 'Không thể tải attribution.'));
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [range]);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadSummary();
    }

    void loadSummary();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadSummary]);

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Attribution đơn hàng</h1>
          <p style={descriptionStyle}>
            Báo cáo MVP theo <code>utm_source</code> lưu trên đơn khi tạo. Đây
            là first-touch-enough cho Plan G; không tính CPC hay tối ưu ads tự
            động.
          </p>
        </div>
        <div style={filterRowStyle}>
          <label style={labelStyle}>
            Từ ngày
            <Input
              type="date"
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label style={labelStyle}>
            Đến ngày
            <Input
              type="date"
              value={range.to}
              onChange={(event) =>
                setRange((current) => ({ ...current, to: event.target.value }))
              }
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => void loadSummary()}
            disabled={loading}
          >
            {loading ? 'Đang tải...' : 'Tải lại'}
          </Button>
        </div>
      </header>

      {error ? (
        <p role="alert" style={alertStyle}>
          {error}
        </p>
      ) : null}

      <section style={summaryGridStyle}>
        <SummaryCard
          label="Tổng đơn trong kỳ"
          value={String(summary?.totalOrders ?? 0)}
        />
        <SummaryCard
          label="Tổng giá trị đơn"
          value={formatVnd(summary?.totalRevenueVnd ?? '0')}
        />
        <SummaryCard
          label="Số nguồn"
          value={String(summary?.sources.length ?? 0)}
        />
      </section>

      <Card style={{ marginTop: 24 }}>
        <h2 style={sectionTitleStyle}>Nguồn tạo đơn</h2>
        {loading ? (
          <MutedText>Đang tải attribution...</MutedText>
        ) : !summary || summary.sources.length === 0 ? (
          <EmptyState>Chưa có đơn hàng trong khoảng ngày này.</EmptyState>
        ) : (
          <Table style={{ marginTop: 16, minWidth: 640 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>utm_source</TableHeaderCell>
                <TableHeaderCell>Số đơn</TableHeaderCell>
                <TableHeaderCell>Giá trị đơn</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {summary.sources.map((source) => (
                <TableRow key={source.utmSource ?? 'unknown'}>
                  <TableCell>{source.label}</TableCell>
                  <TableCell>{source.orderCount}</TableCell>
                  <TableCell>
                    {formatVnd(source.revenueVnd)}
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card style={summaryCardStyle}>
      <span style={mutedStyle}>{label}</span>
      <strong style={{ color: colorTextBody, fontSize: 22 }}>{value}</strong>
    </Card>
  );
}

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 29);
  return {
    from: toDateInputValue(from),
    to: toDateInputValue(to),
  };
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function formatVnd(value: string) {
  const sign = value.startsWith('-') ? '-' : '';
  const digits = sign ? value.slice(1) : value;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped} đ`;
}

const headerStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  justifyContent: 'space-between',
};

const descriptionStyle: CSSProperties = {
  color: '#475569',
  fontSize: 18,
  maxWidth: 820,
};

const filterRowStyle: CSSProperties = {
  alignItems: 'flex-end',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
};

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  fontWeight: 700,
  gap: 6,
};

// Tinted danger banner (background + border), distinct from the shared
// `ErrorText` primitive's plain colored-text treatment. Only `color` has an
// exact token match (`colorDanger`); the tint colors (#fef2f2/#fecaca) don't
// match anything in tokens.ts, so this stays bespoke — same "tinted banner"
// carve-out as advisor/calendar.
const alertStyle: CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: 12,
  color: colorDanger,
  marginTop: 16,
  padding: 16,
};

const summaryGridStyle: CSSProperties = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  marginTop: 24,
};

const summaryCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 20,
};

// No bottom margin (unlike the other pages' section titles, which use
// `'0 0 16px'` and so map cleanly onto `Card`'s `title` prop) — the table
// below supplies its own `marginTop: 16`, while the loading/empty states
// sit flush under the heading. Kept as a manual <h2> inside a bare `Card` so
// that flush spacing is preserved exactly instead of double-gapping.
const sectionTitleStyle: CSSProperties = {
  fontSize: 22,
  margin: 0,
};

const mutedStyle: CSSProperties = {
  color: colorTextMuted,
};
