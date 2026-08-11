'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiClientError,
  getCodReport,
  reconcileCodBatch,
  reconcileCodOrder,
  recordCodCollection,
  type CodExpectation,
  type CodReport,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorDanger,
  colorSuccess,
  colorTextBody,
  colorTextMuted,
  EmptyState,
  ErrorText,
  Input,
  MutedText,
  SuccessText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../../components/ui';

/**
 * Safety cap on how many sequential `/v1/cod/reconcile/batch` calls
 * `handleBatchReconcile` will make while auto-continuing through
 * `hasMore` pages. Each call reconciles at most 100 orders (mirrors
 * `RECONCILE_BATCH_LIMIT` in backend/apps/api/src/modules/cod/cod.service.ts), so
 * this allows up to 3,000 orders in a single click — generous for any real
 * org — while still guarding against looping forever if `hasMore` were ever
 * stuck `true`. Mirrors the runaway-guard philosophy of that same service's
 * `RECONCILABLE_MAX_PAGES`: stop and say so, rather than hang.
 */
const MAX_BATCH_RECONCILE_CALLS = 30;

export default function CodPage() {
  const [report, setReport] = useState<CodReport | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    done: number;
    remaining: number;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every load; a resolved response is applied only while it is
  // still the latest, so an older org's in-flight load can't overwrite the
  // current org's data after a switch.
  const loadSeqRef = useRef(0);

  const loadReport = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const next = await getCodReport();
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setReport(next);
      setAmounts((current) => defaultAmounts(next.expectations, current));
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setError(getApiErrorMessage(err, 'Không thể tải báo cáo COD.'));
      setReport(null);
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

  async function handleRecordCollection(expectation: CodExpectation) {
    const amountVnd = amounts[expectation.orderId]?.trim() ?? '';
    if (!/^\d+$/.test(amountVnd)) {
      setError('Số tiền thu COD phải là VND nguyên, không dùng số lẻ.');
      return;
    }

    setBusyOrderId(expectation.orderId);
    setError(null);
    setMessage(null);

    try {
      await recordCodCollection({
        orderId: expectation.orderId,
        amountVnd,
        note: notes[expectation.orderId],
      });
      const result = await reconcileCodOrder(expectation.orderId);
      setMessage(
        result.discrepancy
          ? `Đã ghi nhận thu COD, còn lệch ${formatVnd(
              result.summary.deltaVnd,
            )}.`
          : 'Đã ghi nhận thu COD và đối soát khớp.',
      );
      setNotes((current) => ({ ...current, [expectation.orderId]: '' }));
      await loadReport();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể ghi nhận thu COD.'));
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleBatchReconcile() {
    setBatching(true);
    setError(null);
    setMessage(null);
    setBatchProgress(null);

    // Reconciling "all open COD" only processes up to 100 orders per call
    // (see CodReconcileBatchResponse in backend/packages/contracts/openapi.yaml);
    // auto-continue here (still with no explicit orderIds, so each call just
    // picks up the next batch) instead of leaving the user to click the
    // button again for every 100 orders, showing visible progress between
    // calls so it never looks like the button silently did nothing.
    let totalReconciled = 0;

    try {
      for (let call = 0; call < MAX_BATCH_RECONCILE_CALLS; call += 1) {
        const result = await reconcileCodBatch();
        totalReconciled += result.reconciled;

        if (!result.hasMore) {
          setMessage(`Đã đối soát ${totalReconciled} đơn COD.`);
          await loadReport();
          return;
        }

        setBatchProgress({ done: totalReconciled, remaining: result.remaining });
      }

      // Runaway guard tripped: still more to do after MAX_BATCH_RECONCILE_CALLS
      // calls. Stop and say so plainly instead of looping forever — clicking
      // the button again resumes from wherever this left off.
      setMessage(
        `Đã đối soát ${totalReconciled} đơn COD, vẫn còn đơn COD chưa xử lý. Nhấn "Đối soát tất cả" để tiếp tục.`,
      );
      await loadReport();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể đối soát COD.'));
    } finally {
      setBatching(false);
      setBatchProgress(null);
    }
  }

  const summary = report?.summary;

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Đối soát COD</h1>
          <p style={descriptionStyle}>
            Theo dõi tiền COD dự kiến theo `orders.total_vnd`, ghi nhận tiền đã
            thu và xử lý hàng đợi lệch cho chủ shop/kho.
          </p>
        </div>
        <div style={buttonRowStyle}>
          <Button
            variant="secondary"
            onClick={() => void handleBatchReconcile()}
            disabled={batching || loading}
          >
            {batching ? 'Đang đối soát...' : 'Đối soát tất cả'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void loadReport()}
            disabled={loading}
          >
            {loading ? 'Đang tải...' : 'Tải lại'}
          </Button>
        </div>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {batchProgress ? (
        <MutedText style={{ marginTop: 20 }}>
          {`Đang đối soát... đã xong ${batchProgress.done}, còn ${batchProgress.remaining} đơn.`}
        </MutedText>
      ) : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <section style={summaryGridStyle}>
        <SummaryCard label="COD mở" value={String(summary?.openCount ?? 0)} />
        <SummaryCard
          label="Đơn đang lệch"
          value={String(summary?.discrepancyCount ?? 0)}
        />
        <SummaryCard
          label="Dự kiến thu"
          value={formatVnd(summary?.expectedVnd ?? '0')}
        />
        <SummaryCard
          label="Đã ghi nhận"
          value={formatVnd(summary?.collectedVnd ?? '0')}
        />
      </section>

      <Card title="COD đang mở" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText style={{ fontSize: 14 }}>Đang tải danh sách COD...</MutedText>
        ) : !report || report.expectations.length === 0 ? (
          <EmptyState>Không có đơn COD cần đối soát.</EmptyState>
        ) : (
          <>
            {report.expectationsTruncated ? (
              <MutedText style={{ fontSize: 14 }}>
                Chỉ hiển thị 100 khoản COD mới nhất; tổng bên trên vẫn tính đủ
                toàn bộ.
              </MutedText>
            ) : null}
            <Table style={{ minWidth: 980 }}>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Mã đơn</TableHeaderCell>
                  <TableHeaderCell>Khách</TableHeaderCell>
                  <TableHeaderCell>Trạng thái COD</TableHeaderCell>
                  <TableHeaderCell>Dự kiến</TableHeaderCell>
                  <TableHeaderCell>Đã thu</TableHeaderCell>
                  <TableHeaderCell>Lệch</TableHeaderCell>
                  <TableHeaderCell>Ghi nhận thu</TableHeaderCell>
                </TableRow>
              </TableHead>
              <tbody>
                {report.expectations.map((expectation) => (
                  <TableRow key={expectation.id}>
                    <TableCell>{shortId(expectation.orderId)}</TableCell>
                    <TableCell>
                      <strong>
                        {expectation.order?.customerName ?? 'Khách chưa đặt tên'}
                      </strong>
                      <br />
                      <span style={mutedStyle}>
                        {expectation.order?.phoneE164 ?? 'Chưa có SĐT'}
                      </span>
                    </TableCell>
                    <TableCell>{formatCodStatus(expectation.status)}</TableCell>
                    <TableCell>
                      {formatVnd(expectation.expectedVnd)}
                    </TableCell>
                    <TableCell>
                      {formatVnd(expectation.collectedVnd)}
                    </TableCell>
                    <TableCell>
                      <span style={deltaStyle(expectation.deltaVnd)}>
                        {formatVnd(expectation.deltaVnd)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div style={collectionFormStyle}>
                        <Input
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={amounts[expectation.orderId] ?? ''}
                          onChange={(event) =>
                            setAmounts((current) => ({
                              ...current,
                              [expectation.orderId]: event.target.value,
                            }))
                          }
                          aria-label={`Số tiền COD thu cho đơn ${shortId(
                            expectation.orderId,
                          )}`}
                        />
                        <Input
                          value={notes[expectation.orderId] ?? ''}
                          onChange={(event) =>
                            setNotes((current) => ({
                              ...current,
                              [expectation.orderId]: event.target.value,
                            }))
                          }
                          placeholder="Ghi chú"
                        />
                        <Button
                          variant="link"
                          onClick={() => void handleRecordCollection(expectation)}
                          disabled={busyOrderId === expectation.orderId}
                          style={{ textAlign: 'left' }}
                        >
                          {busyOrderId === expectation.orderId
                            ? 'Đang lưu...'
                            : 'Ghi nhận'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>

      <Card title="Hàng đợi lệch COD" style={{ marginTop: 24 }}>
        {!report || report.discrepancies.length === 0 ? (
          <EmptyState>Chưa có lệch COD mở.</EmptyState>
        ) : (
          <>
            {report.discrepanciesTruncated ? (
              <MutedText style={{ fontSize: 14 }}>
                Chỉ hiển thị 100 chênh lệch COD mới nhất; tổng bên trên vẫn
                tính đủ toàn bộ.
              </MutedText>
            ) : null}
            <Table style={{ minWidth: 980 }}>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Mã đơn</TableHeaderCell>
                  <TableHeaderCell>Dự kiến</TableHeaderCell>
                  <TableHeaderCell>Đã thu</TableHeaderCell>
                  <TableHeaderCell>Lệch</TableHeaderCell>
                  <TableHeaderCell>Ghi chú</TableHeaderCell>
                  <TableHeaderCell>Tạo lúc</TableHeaderCell>
                </TableRow>
              </TableHead>
              <tbody>
                {report.discrepancies.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{shortId(item.orderId)}</TableCell>
                    <TableCell>{formatVnd(item.expectedVnd)}</TableCell>
                    <TableCell>{formatVnd(item.collectedVnd)}</TableCell>
                    <TableCell>
                      <span style={deltaStyle(item.deltaVnd)}>
                        {formatVnd(item.deltaVnd)}
                      </span>
                    </TableCell>
                    <TableCell>{item.note ?? '-'}</TableCell>
                    <TableCell>{formatDateTime(item.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </>
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

function defaultAmounts(
  expectations: CodExpectation[],
  current: Record<string, string>,
) {
  const next = { ...current };
  for (const expectation of expectations) {
    if (next[expectation.orderId] !== undefined) {
      continue;
    }
    next[expectation.orderId] = remainingVnd(expectation);
  }
  return next;
}

function remainingVnd(expectation: CodExpectation) {
  const expected = BigInt(expectation.expectedVnd);
  const collected = BigInt(expectation.collectedVnd);
  const remaining = expected - collected;
  return remaining > 0n ? remaining.toString() : expectation.expectedVnd;
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function formatCodStatus(status: string) {
  const labels: Record<string, string> = {
    open: 'Đang chờ thu',
    matched: 'Đã khớp',
    discrepancy: 'Đang lệch',
    written_off: 'Đã xoá lệch',
  };

  return labels[status] ?? status;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatVnd(value: string) {
  const sign = value.startsWith('-') ? '-' : '';
  const digits = sign ? value.slice(1) : value;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped} đ`;
}

function deltaStyle(value: string): CSSProperties {
  if (value === '0') {
    return { color: colorSuccess, fontWeight: 800 };
  }
  return { color: colorDanger, fontWeight: 800 };
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
  maxWidth: 780,
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
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

const collectionFormStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  minWidth: 220,
};

const mutedStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 14,
};
