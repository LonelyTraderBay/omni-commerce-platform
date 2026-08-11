'use client';

import { useSearchParams } from 'next/navigation';
import {
  Fragment,
  Suspense,
  type CSSProperties,
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  ApiClientError,
  cancelOrder,
  confirmOrder,
  createShipment,
  downloadOrdersExport,
  getOrder,
  listOrders,
  listShipments,
  markOrderDone,
  returnOrder,
  type Order,
  type OrderItem,
  type OrdersExportFormat,
  type OrderStatus,
  type Shipment,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorBackgroundSubtle,
  colorBorder,
  colorBorderStrong,
  colorPrimary,
  colorTextBody,
  colorTextHeading,
  colorTextMuted,
  colorWarning,
  EmptyState,
  ErrorText,
  MutedText,
  SuccessText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../../../components/ui';

const statusOptions: Array<{ value: OrderStatus | ''; label: string }> = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'draft', label: 'Nháp / chờ xác nhận' },
  { value: 'confirmed', label: 'Đã xác nhận' },
  { value: 'shipped', label: 'Đang giao' },
  { value: 'done', label: 'Hoàn tất' },
  { value: 'cancelled', label: 'Đã huỷ' },
  { value: 'returned', label: 'Hoàn hàng' },
];

function OrdersContent() {
  const searchParams = useSearchParams();
  const initialStatus = normalizeStatus(searchParams.get('status'));
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState<OrderStatus | ''>(initialStatus);
  const [loading, setLoading] = useState(true);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<OrdersExportFormat | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [orderDetails, setOrderDetails] = useState<
    Record<string, { items: OrderItem[]; shipments: Shipment[] }>
  >({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setOrders(await listOrders(status || undefined));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tải danh sách đơn hàng.'));
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadOrders();
    }

    void loadOrders();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadOrders]);

  async function runOrderAction(
    order: Order,
    action: 'confirm' | 'cancel' | 'shipment' | 'return' | 'done',
  ) {
    setBusyOrderId(order.id);
    setError(null);
    setMessage(null);

    try {
      const shipmentResult =
        action === 'shipment'
          ? await createShipment({ orderId: order.id, provider: 'manual' })
          : null;
      const updated =
        action === 'confirm'
          ? await confirmOrder(order.id)
          : action === 'cancel'
            ? await cancelOrder(order.id)
            : action === 'return'
              ? await returnOrder(order.id, { restock: true })
              : action === 'done'
                ? await markOrderDone(order.id)
                : shipmentResult?.order;
      setOrders((current) =>
        updated
          ? current.map((item) => (item.id === updated.id ? updated : item))
          : current,
      );
      // The order's lifecycle changed (e.g. a shipment was created), so any
      // cached expanded-row detail for it is now stale — drop it so the next
      // expand refetches instead of showing the pre-mutation snapshot.
      setOrderDetails((current) => {
        const next = { ...current };
        delete next[order.id];
        return next;
      });
      setMessage(
        action === 'shipment'
          ? `Đã tạo vận đơn ${shipmentResult?.shipment.trackingCode ?? ''} cho đơn ${shortId(
              order.id,
            )}.`
          : action === 'return'
            ? `Đã hoàn hàng và nhập lại kho cho đơn ${shortId(order.id)}.`
            : action === 'done'
              ? `Đã hoàn tất đơn ${shortId(order.id)}.`
              : `Đã cập nhật đơn ${shortId(order.id)}.`,
      );
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể cập nhật đơn hàng.'));
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleExport(format: OrdersExportFormat) {
    setExporting(format);
    setError(null);
    setMessage(null);

    try {
      const file = await downloadOrdersExport({
        format,
        status: status || undefined,
      });
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`Đã tải file ${file.filename}.`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể xuất đơn hàng.'));
    } finally {
      setExporting(null);
    }
  }

  async function handleToggleDetail(orderId: string) {
    if (expandedOrderId === orderId) {
      setExpandedOrderId(null);
      return;
    }
    setExpandedOrderId(orderId);
    setDetailError(null);
    if (orderDetails[orderId]) {
      return; // already cached, no need to refetch
    }
    setDetailLoading(orderId);
    try {
      const [order, shipments] = await Promise.all([
        getOrder(orderId),
        listShipments(orderId),
      ]);
      setOrderDetails((current) => ({
        ...current,
        [orderId]: { items: order.items ?? [], shipments },
      }));
    } catch (err) {
      setDetailError(getApiErrorMessage(err, 'Không thể tải chi tiết đơn hàng.'));
    } finally {
      setDetailLoading(null);
    }
  }

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Đơn hàng</h1>
          <p style={descriptionStyle}>
            Theo dõi đơn theo trạng thái, xác nhận, huỷ, chuyển sang giao hàng
            và tải file xuất đơn.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void loadOrders()}
          disabled={loading}
        >
          {loading ? 'Đang tải...' : 'Tải lại'}
        </Button>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <Card style={toolbarStyle}>
        <label style={labelStyle}>
          Lọc trạng thái
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as OrderStatus | '')}
            style={inputStyle}
          >
            {statusOptions.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div style={exportRowStyle}>
          {(['csv', 'xlsx', 'pdf'] as OrdersExportFormat[]).map((format) => (
            <Button
              key={format}
              variant="secondary"
              onClick={() => void handleExport(format)}
              disabled={exporting !== null}
            >
              {exporting === format ? 'Đang xuất...' : `Xuất ${format.toUpperCase()}`}
            </Button>
          ))}
        </div>
      </Card>

      <Card style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText>Đang tải đơn hàng...</MutedText>
        ) : orders.length === 0 ? (
          <EmptyState>Chưa có đơn hàng phù hợp bộ lọc.</EmptyState>
        ) : (
          <Table style={{ minWidth: 920 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Mã đơn</TableHeaderCell>
                <TableHeaderCell>Khách</TableHeaderCell>
                <TableHeaderCell>Trạng thái</TableHeaderCell>
                <TableHeaderCell>Thanh toán</TableHeaderCell>
                <TableHeaderCell>Tổng tiền</TableHeaderCell>
                <TableHeaderCell>Tạo lúc</TableHeaderCell>
                <TableHeaderCell>Thao tác</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {orders.map((order) => {
                const isExpanded = expandedOrderId === order.id;
                const detail = orderDetails[order.id];

                return (
                  <Fragment key={order.id}>
                    <TableRow>
                      <TableCell>
                        <Button
                          variant="link"
                          onClick={() => void handleToggleDetail(order.id)}
                          style={detailToggleButtonStyle}
                        >
                          <span aria-hidden="true">
                            {isExpanded ? '▾' : '▸'}
                          </span>
                          {shortId(order.id)}
                        </Button>
                      </TableCell>
                      <TableCell>
                        <strong>{order.customerName ?? 'Khách chưa đặt tên'}</strong>
                        <br />
                        <span style={mutedStyle}>{order.phoneE164 ?? 'Chưa có SĐT'}</span>
                      </TableCell>
                      <TableCell>{formatStatus(order.status)}</TableCell>
                      <TableCell>
                        {formatPaymentMethod(order.paymentMethod)}
                      </TableCell>
                      <TableCell>{formatMoney(order.totalVnd)}</TableCell>
                      <TableCell>{formatDateTime(order.createdAt)}</TableCell>
                      <TableCell>
                        <div style={actionRowStyle}>
                          {order.status === 'draft' ? (
                            <Button
                              variant="link"
                              onClick={() => void runOrderAction(order, 'confirm')}
                              disabled={busyOrderId === order.id}
                            >
                              Xác nhận
                            </Button>
                          ) : null}
                          {order.status === 'confirmed' ? (
                            <Button
                              variant="link"
                              onClick={() => void runOrderAction(order, 'shipment')}
                              disabled={busyOrderId === order.id}
                            >
                              Tạo vận đơn
                            </Button>
                          ) : null}
                          {order.status === 'draft' || order.status === 'confirmed' ? (
                            <Button
                              variant="danger"
                              onClick={() => void runOrderAction(order, 'cancel')}
                              disabled={busyOrderId === order.id}
                            >
                              Huỷ
                            </Button>
                          ) : null}
                          {order.status === 'shipped' ? (
                            <Button
                              variant="success"
                              onClick={() => void runOrderAction(order, 'done')}
                              disabled={busyOrderId === order.id}
                            >
                              Hoàn tất
                            </Button>
                          ) : null}
                          {order.status === 'shipped' || order.status === 'done' ? (
                            <Button
                              variant="link"
                              style={{ color: colorWarning }}
                              onClick={() => void runOrderAction(order, 'return')}
                              disabled={busyOrderId === order.id}
                            >
                              Hoàn hàng
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded ? (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          style={{ background: colorBackgroundSubtle, padding: 16 }}
                        >
                          {detailLoading === order.id ? (
                            <MutedText>Đang tải chi tiết...</MutedText>
                          ) : detailError ? (
                            <ErrorText>{detailError}</ErrorText>
                          ) : detail ? (
                            <div style={detailContentStyle}>
                              <div>
                                <h3 style={detailHeadingStyle}>Sản phẩm</h3>
                                {detail.items.length === 0 ? (
                                  <MutedText>Chưa có sản phẩm nào.</MutedText>
                                ) : (
                                  <div style={{ overflowX: 'auto' }}>
                                    <table style={detailTableStyle}>
                                      <thead>
                                        <tr>
                                          <th style={detailTableHeaderStyle}>
                                            Sản phẩm/SKU
                                          </th>
                                          <th style={detailTableHeaderStyle}>
                                            Số lượng
                                          </th>
                                          <th style={detailTableHeaderStyle}>
                                            Đơn giá
                                          </th>
                                          <th style={detailTableHeaderStyle}>
                                            Thành tiền
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {detail.items.map((item) => (
                                          <tr key={item.id}>
                                            <td style={detailTableCellStyle}>
                                              {item.titleSnapshot}
                                              <br />
                                              <span style={mutedStyle}>
                                                {item.skuSnapshot}
                                              </span>
                                            </td>
                                            <td style={detailTableCellStyle}>
                                              {item.qty}
                                            </td>
                                            <td style={detailTableCellStyle}>
                                              {formatMoney(item.unitPriceVnd)}
                                            </td>
                                            <td style={detailTableCellStyle}>
                                              {formatMoney(item.lineTotalVnd)}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                              <div>
                                <h3 style={detailHeadingStyle}>Vận đơn</h3>
                                {detail.shipments.length === 0 ? (
                                  <MutedText>Chưa có vận đơn nào.</MutedText>
                                ) : (
                                  <div style={{ overflowX: 'auto' }}>
                                    <table style={detailTableStyle}>
                                      <thead>
                                        <tr>
                                          <th style={detailTableHeaderStyle}>
                                            Đơn vị
                                          </th>
                                          <th style={detailTableHeaderStyle}>
                                            Mã vận đơn
                                          </th>
                                          <th style={detailTableHeaderStyle}>
                                            Trạng thái
                                          </th>
                                          <th style={detailTableHeaderStyle}>
                                            Vận đơn
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {detail.shipments.map((shipment) => (
                                          <tr key={shipment.id}>
                                            <td style={detailTableCellStyle}>
                                              {formatShippingProvider(
                                                shipment.provider,
                                              )}
                                            </td>
                                            <td style={detailTableCellStyle}>
                                              {shipment.trackingCode ??
                                                'Chưa có mã vận đơn'}
                                            </td>
                                            <td style={detailTableCellStyle}>
                                              {shipment.status}
                                            </td>
                                            <td style={detailTableCellStyle}>
                                              {shipment.labelUrl ? (
                                                <a
                                                  href={shipment.labelUrl}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                  style={linkButtonStyle}
                                                >
                                                  Xem vận đơn
                                                </a>
                                              ) : (
                                                '—'
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}

export default function OrdersPage() {
  return (
    <Suspense
      fallback={
        <main>
          <MutedText>Đang tải...</MutedText>
        </main>
      }
    >
      <OrdersContent />
    </Suspense>
  );
}

function normalizeStatus(value: string | null): OrderStatus | '' {
  return statusOptions.some((option) => option.value === value)
    ? (value as OrderStatus | '')
    : '';
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function formatStatus(status: OrderStatus) {
  return (
    statusOptions.find((option) => option.value === status)?.label ?? status
  );
}

function formatPaymentMethod(method: string) {
  const labels: Record<string, string> = {
    bank_transfer: 'Chuyển khoản',
    cod: 'COD',
    other: 'Khác',
  };

  return labels[method] ?? method;
}

function formatShippingProvider(provider: string) {
  const labels: Record<string, string> = {
    ghn: 'GHN',
    manual: 'Thủ công',
  };

  return labels[provider] ?? provider;
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

const toolbarStyle: CSSProperties = {
  alignItems: 'end',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  justifyContent: 'space-between',
  marginTop: 24,
  padding: 16,
};

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14,
  fontWeight: 700,
  gap: 6,
};

const inputStyle: CSSProperties = {
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: 10,
  color: colorTextBody,
  font: 'inherit',
  minWidth: 240,
  padding: '11px 12px',
};

const exportRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
};

const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
};

const detailToggleButtonStyle: CSSProperties = {
  alignItems: 'center',
  display: 'inline-flex',
  gap: 6,
};

const detailContentStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const detailHeadingStyle: CSSProperties = {
  color: colorTextHeading,
  fontSize: 14,
  fontWeight: 700,
  margin: '0 0 8px',
};

const detailTableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
};

const detailTableHeaderStyle: CSSProperties = {
  borderBottom: `1px solid ${colorBorder}`,
  color: colorTextHeading,
  fontSize: 13,
  fontWeight: 700,
  padding: '8px 12px',
  textAlign: 'left',
};

const detailTableCellStyle: CSSProperties = {
  borderBottom: `1px solid ${colorBorder}`,
  color: colorTextBody,
  fontSize: 14,
  padding: '8px 12px',
  verticalAlign: 'top',
};

const mutedStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 14,
};

const linkButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colorPrimary,
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 800,
  padding: 0,
};
