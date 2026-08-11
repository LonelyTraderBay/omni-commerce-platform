'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiClientError,
  downloadAccountingExport,
  getPnlBySku,
  getPnlSummary,
  type PnlSku,
  type PnlSummary,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorDanger,
  colorSuccess,
  colorTextBody,
  colorTextHeading,
  colorTextMuted,
  EmptyState,
  ErrorText,
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

export default function PnlPage() {
  const [range, setRange] = useState<DateRange>(() => defaultRange());
  const [summary, setSummary] = useState<PnlSummary | null>(null);
  const [skuRows, setSkuRows] = useState<PnlSku[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountingExporting, setAccountingExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every load; a resolved response is applied only while it is
  // still the latest, so an older org's (or date range's) in-flight load can't
  // overwrite the current data after a switch.
  const loadSeqRef = useRef(0);

  const loadReport = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const [nextSummary, nextSkuRows] = await Promise.all([
        getPnlSummary(range),
        getPnlBySku(range),
      ]);
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setSummary(nextSummary);
      setSkuRows(nextSkuRows);
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setError(getApiErrorMessage(err, 'Không thể tải báo cáo lãi gộp.'));
      setSummary(null);
      setSkuRows([]);
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
      void loadReport();
    }

    void loadReport();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadReport]);

  function handleDownloadCsv() {
    const rows = [
      [
        'type',
        'key',
        'revenueVnd',
        'cogsVnd',
        'grossProfitVnd',
        'shippingVnd',
        'adSpendVnd',
        'netProfitVnd',
        'orderCount',
        'qty',
      ],
      ...(summary?.days ?? []).map((day) => [
        'day',
        day.day,
        day.revenueVnd,
        day.cogsVnd,
        day.grossProfitVnd,
        day.shippingVnd,
        day.adSpendVnd,
        day.netProfitVnd,
        String(day.orderCount),
        '',
      ]),
      ...skuRows.map((sku) => [
        'sku',
        sku.sku,
        sku.revenueVnd,
        sku.cogsVnd,
        sku.grossProfitVnd,
        '',
        '',
        '',
        String(sku.orderCount),
        String(sku.qty),
      ]),
    ];
    downloadCsv(`pnl-${range.from}-${range.to}.csv`, rows);
  }

  async function handleAccountingExport() {
    setAccountingExporting(true);
    setError(null);
    try {
      const file = await downloadAccountingExport(range);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tải export kế toán.'));
    } finally {
      setAccountingExporting(false);
    }
  }

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Lãi gộp</h1>
          <p style={descriptionStyle}>
            Báo cáo doanh thu, COGS và lãi gộp cho đơn đã bán
            (shipped/done). Tiền dùng BIGINT VND, không dùng số lẻ.
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
            onClick={() => void loadReport()}
            disabled={loading}
          >
            {loading ? 'Đang tải...' : 'Tải lại'}
          </Button>
          <Button
            variant="secondary"
            onClick={handleDownloadCsv}
            disabled={loading || (!summary && skuRows.length === 0)}
          >
            Tải CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleAccountingExport()}
            disabled={loading || accountingExporting}
          >
            {accountingExporting ? 'Đang tải...' : 'Export kế toán'}
          </Button>
        </div>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <section style={summaryGridStyle}>
        <SummaryCard
          label="Doanh thu"
          value={formatVnd(summary?.revenueVnd ?? '0')}
        />
        <SummaryCard label="COGS" value={formatVnd(summary?.cogsVnd ?? '0')} />
        <SummaryCard
          label="Lãi gộp"
          value={formatVnd(summary?.grossProfitVnd ?? '0')}
        />
        <SummaryCard
          label="Phí vận chuyển"
          value={formatVnd(summary?.shippingVnd ?? '0')}
        />
        <SummaryCard
          label="Chi phí ads"
          value={formatVnd(summary?.adSpendVnd ?? '0')}
        />
        <SummaryCard
          label="Lãi ròng"
          value={formatVnd(summary?.netProfitVnd ?? '0')}
        />
        <SummaryCard label="Đơn đã bán" value={String(summary?.orderCount ?? 0)} />
      </section>

      <Card title="Theo ngày" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText style={{ fontSize: 14 }}>Đang tải lãi gộp theo ngày...</MutedText>
        ) : !summary || summary.days.length === 0 ? (
          <EmptyState>Chưa có đơn shipped/done trong khoảng ngày này.</EmptyState>
        ) : (
          <Table style={{ minWidth: 860 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Ngày</TableHeaderCell>
                <TableHeaderCell>Đơn</TableHeaderCell>
                <TableHeaderCell>Doanh thu</TableHeaderCell>
                <TableHeaderCell>COGS</TableHeaderCell>
                <TableHeaderCell>Lãi gộp</TableHeaderCell>
                <TableHeaderCell>Ship</TableHeaderCell>
                <TableHeaderCell>Ads</TableHeaderCell>
                <TableHeaderCell>Lãi ròng</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {summary.days.map((day) => (
                <TableRow key={day.day}>
                  <TableCell>{formatDay(day.day)}</TableCell>
                  <TableCell>{day.orderCount}</TableCell>
                  <TableCell>{formatVnd(day.revenueVnd)}</TableCell>
                  <TableCell>{formatVnd(day.cogsVnd)}</TableCell>
                  <TableCell>
                    <span style={profitStyle(day.grossProfitVnd)}>
                      {formatVnd(day.grossProfitVnd)}
                    </span>
                  </TableCell>
                  <TableCell>{formatVnd(day.shippingVnd)}</TableCell>
                  <TableCell>{formatVnd(day.adSpendVnd)}</TableCell>
                  <TableCell>
                    <span style={profitStyle(day.netProfitVnd)}>
                      {formatVnd(day.netProfitVnd)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Theo SKU" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText style={{ fontSize: 14 }}>Đang tải lãi gộp theo SKU...</MutedText>
        ) : skuRows.length === 0 ? (
          <EmptyState>Chưa có SKU bán trong khoảng ngày này.</EmptyState>
        ) : (
          <Table style={{ minWidth: 860 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>SKU</TableHeaderCell>
                <TableHeaderCell>SL</TableHeaderCell>
                <TableHeaderCell>Đơn</TableHeaderCell>
                <TableHeaderCell>Doanh thu dòng</TableHeaderCell>
                <TableHeaderCell>COGS</TableHeaderCell>
                <TableHeaderCell>Lãi gộp</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {skuRows.map((sku) => (
                <TableRow key={sku.sku}>
                  <TableCell>{sku.sku}</TableCell>
                  <TableCell>{sku.qty}</TableCell>
                  <TableCell>{sku.orderCount}</TableCell>
                  <TableCell>{formatVnd(sku.revenueVnd)}</TableCell>
                  <TableCell>{formatVnd(sku.cogsVnd)}</TableCell>
                  <TableCell>
                    <span style={profitStyle(sku.grossProfitVnd)}>
                      {formatVnd(sku.grossProfitVnd)}
                    </span>
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

function profitStyle(value: string): CSSProperties {
  return {
    color: value.startsWith('-') ? colorDanger : colorSuccess,
    fontWeight: 800,
  };
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => `"${cell.replace(/"/g, '""')}"`)
        .join(','),
    )
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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
  maxWidth: 780,
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

const mutedStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 14,
};
