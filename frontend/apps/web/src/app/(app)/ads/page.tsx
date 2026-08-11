'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiClientError,
  getAdSpendSummary,
  importAdSpendCsv,
  listAdSpend,
  type AdSpendRecord,
  type AdSpendSummary,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorBackgroundCard,
  colorBorderStrong,
  colorTextBody,
  colorTextHeading,
  colorTextMuted,
  EmptyState,
  ErrorText,
  Input,
  MutedText,
  radiusSm,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textarea,
} from '../../../components/ui';

type DateRange = {
  from: string;
  to: string;
};

const SAMPLE_CSV = 'date,campaign,amount_vnd\n2026-07-25,Meta prospecting,150000';

export default function AdsPage() {
  const [range, setRange] = useState<DateRange>(() => defaultRange());
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [rows, setRows] = useState<AdSpendRecord[]>([]);
  const [summary, setSummary] = useState<AdSpendSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every load; a resolved response is applied only while it is
  // still the latest, so an older org's (or date range's) in-flight load can't
  // overwrite the current data after a switch.
  const loadSeqRef = useRef(0);

  const loadAds = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const [nextRows, nextSummary] = await Promise.all([
        listAdSpend({ ...range, limit: 200 }),
        getAdSpendSummary(range),
      ]);
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setRows(nextRows);
      setSummary(nextSummary);
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setRows([]);
      setSummary(null);
      setError(getApiErrorMessage(err, 'Không thể tải chi phí ads.'));
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
      void loadAds();
    }

    void loadAds();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadAds]);

  async function handleImport() {
    setImporting(true);
    setMessage(null);
    setError(null);

    try {
      const result = await importAdSpendCsv(csv);
      setMessage(`Đã import ${result.importedCount} dòng chi phí ads.`);
      await loadAds();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể import CSV ads.'));
    } finally {
      setImporting(false);
    }
  }

  async function handleFileUpload(file: File | null) {
    if (!file) {
      return;
    }
    setCsv(await file.text());
  }

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Chi phí ads</h1>
          <p style={descriptionStyle}>
            Import CSV theo mẫu <code>date,campaign,amount_vnd</code>. Số tiền là
            BIGINT VND, không dùng số lẻ. Meta Ads API sẽ nối sau; hiện tại dùng
            CSV/JSON batch qua Core API.
          </p>
        </div>
        <div style={filterRowStyle}>
          <label style={labelStyle}>
            Từ ngày
            <Input
              type="date"
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({ ...current, from: event.target.value }))
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
            onClick={() => void loadAds()}
            disabled={loading}
          >
            {loading ? 'Đang tải...' : 'Tải lại'}
          </Button>
        </div>
      </header>

      {message ? (
        <p role="status" style={statusStyle}>
          {message}
        </p>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      <section style={summaryGridStyle}>
        <SummaryCard
          label="Tổng chi ads"
          value={formatVnd(summary?.totalVnd ?? '0')}
        />
        <SummaryCard
          label="Số ngày có ads"
          value={String(summary?.days.length ?? 0)}
        />
        <SummaryCard label="Dòng gần đây" value={String(rows.length)} />
      </section>

      <Card style={{ marginTop: 24 }}>
        <div style={sectionHeaderStyle}>
          <div>
            <h2 style={sectionTitleStyle}>Import CSV</h2>
            <MutedText style={{ fontSize: 14 }}>
              Header bắt buộc: <code>date,campaign,amount_vnd</code>. Có thể thêm
              <code> external_id</code> nếu dữ liệu đến từ nguồn ngoài.
            </MutedText>
          </div>
          <label style={uploadButtonStyle}>
            Chọn file CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void handleFileUpload(event.target.files?.[0] ?? null)}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        <Textarea
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          rows={8}
          style={csvTextareaStyle}
        />
        <div style={{ marginTop: 12 }}>
          <Button
            onClick={() => void handleImport()}
            disabled={importing || !csv.trim()}
          >
            {importing ? 'Đang import...' : 'Import chi phí ads'}
          </Button>
        </div>
      </Card>

      <Card title="Tổng theo ngày" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText style={{ fontSize: 14 }}>Đang tải tổng ads theo ngày...</MutedText>
        ) : !summary || summary.days.length === 0 ? (
          <EmptyState>Chưa có chi phí ads trong khoảng ngày này.</EmptyState>
        ) : (
          <Table style={{ minWidth: 760 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Ngày</TableHeaderCell>
                <TableHeaderCell>Chi phí ads</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {summary.days.map((day) => (
                <TableRow key={day.day}>
                  <TableCell>{formatDay(day.day)}</TableCell>
                  <TableCell>{formatVnd(day.amountVnd)}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Dòng đã import" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText style={{ fontSize: 14 }}>Đang tải danh sách ads...</MutedText>
        ) : rows.length === 0 ? (
          <EmptyState>Chưa có dòng ads nào trong khoảng ngày này.</EmptyState>
        ) : (
          <Table style={{ minWidth: 760 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Ngày</TableHeaderCell>
                <TableHeaderCell>Campaign</TableHeaderCell>
                <TableHeaderCell>Nguồn</TableHeaderCell>
                <TableHeaderCell>Số tiền</TableHeaderCell>
                <TableHeaderCell>External ID</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{formatDay(row.date)}</TableCell>
                  <TableCell>{row.campaignName}</TableCell>
                  <TableCell>{formatSource(row.source)}</TableCell>
                  <TableCell>{formatVnd(row.amountVnd)}</TableCell>
                  <TableCell>{row.externalId ?? '-'}</TableCell>
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
  from.setDate(to.getDate() - 6);
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

function formatSource(source: string) {
  return source === 'meta_ads' ? 'Meta Ads' : 'CSV';
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
  }).format(new Date(`${value}T00:00:00.000Z`));
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
  gap: 10,
};

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  fontWeight: 700,
  gap: 6,
};

const summaryGridStyle: CSSProperties = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  marginTop: 24,
};

const summaryCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 16,
};

const sectionHeaderStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  justifyContent: 'space-between',
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 22,
  margin: '0 0 16px',
};

// Deliberate custom override on top of the shared `Textarea`: the CSV editor
// needs a monospace font plus its own marginTop/width, which no primitive
// captures. Border/radius/color/padding/resize now come from `Textarea`
// itself (an intentional 10->8 radius and 12->'11px 12px' padding
// convergence, matching the "resolve near-duplicates" approach used
// throughout tokens.ts).
const csvTextareaStyle: CSSProperties = {
  font: '14px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  marginTop: 12,
  width: '100%',
};

// The upload control must stay a native <label> wrapping a hidden
// <input type="file"> — only a <label> implicitly forwards its click to the
// wrapped control to open the file picker; a `Button` (a <button>) would not
// trigger the native file dialog. Styled to match `Button`'s secondary
// variant via tokens.
const uploadButtonStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: radiusSm,
  color: colorTextBody,
  cursor: 'pointer',
  display: 'inline-flex',
  fontSize: 14,
  fontWeight: 700,
  padding: '9px 12px',
};

const mutedStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 14,
};

// Tinted success banner (background + border), distinct from the shared
// `SuccessText` primitive's plain colored-text treatment — none of its 3
// colors (#ecfdf5/#bbf7d0/#047857) have an exact match in tokens.ts, so it
// stays bespoke per the "tinted banner" carve-out (same pattern as the
// tinted alert banners in attribution/advisor/calendar).
const statusStyle: CSSProperties = {
  background: '#ecfdf5',
  border: '1px solid #bbf7d0',
  borderRadius: 12,
  color: '#047857',
  marginTop: 20,
  padding: 12,
};
