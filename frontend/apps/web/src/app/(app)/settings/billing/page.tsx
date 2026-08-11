'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  ApiClientError,
  getBillingPlan,
  getBillingUsage,
  listBillingInvoices,
  type BillingInvoice,
  type BillingPlan,
  type BillingUsage,
} from '../../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../../lib/auth-session';
import {
  Card,
  ErrorText,
  MutedText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  WarningText,
  colorBackgroundSubtle,
  colorBorder,
  colorTextBody,
  colorTextMuted,
} from '../../../../components/ui';

const PLAN_LABELS: Record<string, string> = {
  free: 'Miễn phí',
  pilot: 'Pilot',
  starter: 'Starter',
  enterprise: 'Enterprise',
};

const BILLING_STATUS_LABELS: Record<string, string> = {
  active: 'Đang hoạt động',
  past_due: 'Quá hạn',
  suspended: 'Tạm ngưng',
};

const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Nháp',
  issued: 'Đã phát hành',
  paid: 'Đã thanh toán',
  void: 'Đã hủy',
};

export default function BillingSettingsPage() {
  const [plan, setPlan] = useState<BillingPlan | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBilling = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [nextPlan, nextUsage, nextInvoices] = await Promise.all([
        getBillingPlan(),
        getBillingUsage(),
        listBillingInvoices(),
      ]);
      setPlan(nextPlan);
      setUsage(nextUsage);
      setInvoices(nextInvoices);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Không thể tải thông tin thanh toán.';
      setError(message);
      setPlan(null);
      setUsage(null);
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadBilling();
    }

    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadBilling]);

  return (
    <main>
      <h1 style={{ margin: 0, fontSize: 32 }}>Thanh toán</h1>
      <p style={{ color: '#475569', fontSize: 18, maxWidth: 760 }}>
        Gói hiện tại, hạn mức sử dụng và hóa đơn thủ công theo ADR 0004. Hệ
        thống chưa thu tiền tự động qua Stripe/PayOS.
      </p>

      {loading ? <MutedText>Đang tải thanh toán...</MutedText> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {plan ? (
        <Card title="Gói dịch vụ" style={{ marginTop: 24 }}>
          <div style={gridStyle}>
            <MetricCard label="Gói" value={formatPlan(plan.plan)} />
            <MetricCard
              label="Trạng thái"
              value={formatBillingStatus(plan.billingStatus)}
            />
            <MetricCard
              label="Email nhận hóa đơn"
              value={plan.billingCustomerEmail ?? 'Chưa cấu hình'}
            />
            <MetricCard
              label="Gia hạn"
              value={formatDateTime(plan.planRenewsAt)}
            />
          </div>

          {plan.billingStatus === 'past_due' ? (
            <WarningText>
              Trạng thái quá hạn đang chặn tự động xác nhận đơn. Chủ shop vẫn
              có thể xử lý thủ công trong lúc đối soát hóa đơn.
            </WarningText>
          ) : null}
        </Card>
      ) : null}

      {plan ? (
        <Card title="Quyền lợi gói" style={{ marginTop: 24 }}>
          <div style={gridStyle}>
            <MetricCard
              label="Số kênh tối đa"
              value={String(plan.entitlements.maxPages)}
            />
            <MetricCard
              label="Token AI / tháng"
              value={formatNumber(plan.entitlements.aiMonthlyTokenLimit)}
            />
            <MetricCard
              label="Tự động xác nhận"
              value={plan.entitlements.autoConfirmAllowed ? 'Bật' : 'Tắt'}
            />
            <MetricCard
              label="Cập nhật hạn mức"
              value={formatDateTime(plan.entitlements.updatedAt)}
            />
          </div>
        </Card>
      ) : null}

      {usage ? (
        <Card title="Mức sử dụng tháng này" style={{ marginTop: 24 }}>
          <MutedText style={{ marginTop: 0 }}>
            Kỳ bắt đầu: {formatDateTime(usage.periodStart)}
          </MutedText>
          <div style={gridStyle}>
            <MetricCard
              label="Kênh đang kết nối"
              value={formatNumber(usage.pagesConnectedCount)}
            />
            <MetricCard
              label="Token AI"
              value={formatNumber(usage.aiTokensMonth)}
            />
            <MetricCard
              label="Đơn hàng"
              value={formatNumber(usage.ordersCountMonth)}
            />
          </div>
        </Card>
      ) : null}

      <Card title="Hóa đơn" style={{ marginTop: 24 }}>
        {invoices.length === 0 ? (
          <MutedText>Chưa có hóa đơn.</MutedText>
        ) : (
          <Table style={{ minWidth: 760 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Kỳ</TableHeaderCell>
                <TableHeaderCell>Số tiền</TableHeaderCell>
                <TableHeaderCell>Trạng thái</TableHeaderCell>
                <TableHeaderCell>Phát hành</TableHeaderCell>
                <TableHeaderCell>Ghi chú</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    {formatDate(invoice.periodStart)} -{' '}
                    {formatDate(invoice.periodEnd)}
                  </TableCell>
                  <TableCell>{formatVnd(invoice.amountVnd)}</TableCell>
                  <TableCell>
                    {formatInvoiceStatus(invoice.status)}
                  </TableCell>
                  <TableCell>{formatDateTime(invoice.issuedAt)}</TableCell>
                  <TableCell>{invoice.note ?? '-'}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricStyle}>
      <div style={{ color: colorTextMuted, fontSize: 13, fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ color: colorTextBody, fontSize: 22, fontWeight: 800 }}>
        {value}
      </div>
    </div>
  );
}

function formatPlan(plan: string) {
  return PLAN_LABELS[plan] ?? plan;
}

function formatBillingStatus(status: string) {
  return BILLING_STATUS_LABELS[status] ?? status;
}

function formatInvoiceStatus(status: string) {
  return INVOICE_STATUS_LABELS[status] ?? status;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('vi-VN').format(value);
}

function formatVnd(value: string) {
  return `${new Intl.NumberFormat('vi-VN').format(Number(value))} đ`;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
  }).format(new Date(value));
}

const gridStyle = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
};

const metricStyle = {
  background: colorBackgroundSubtle,
  border: `1px solid ${colorBorder}`,
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 8,
  padding: 16,
};
