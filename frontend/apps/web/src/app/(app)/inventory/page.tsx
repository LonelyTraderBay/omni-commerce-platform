'use client';

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  adjustStock,
  ApiClientError,
  listLowStock,
  listStockMovements,
  type CatalogVariant,
  type StockMovement,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import { VariantPicker } from '../../../components/variant-picker';
import {
  Button,
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

export default function InventoryPage() {
  const [lowStock, setLowStock] = useState<CatalogVariant[]>([]);
  const [threshold, setThreshold] = useState(5);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [variantId, setVariantId] = useState('');
  const [qtyDelta, setQtyDelta] = useState(1);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [low, moves] = await Promise.all([
        listLowStock(),
        listStockMovements({
          variantId: variantId.trim() || undefined,
          limit: 40,
        }),
      ]);
      setLowStock(low.variants);
      setThreshold(low.threshold);
      setMovements(moves);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tải kho.'));
    } finally {
      setLoading(false);
    }
  }, [variantId]);

  useEffect(() => {
    function onSession(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void load();
    }
    void load();
    window.addEventListener(SESSION_CHANGED_EVENT, onSession);
    window.addEventListener('storage', onSession);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, onSession);
      window.removeEventListener('storage', onSession);
    };
  }, [load]);

  async function handleAdjust(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const result = await adjustStock({
        variantId: variantId.trim(),
        qtyDelta,
        reason: reason.trim() || undefined,
        movementType: qtyDelta > 0 ? 'inbound' : 'outbound',
      });
      setMessage(
        `Đã điều chỉnh ${result.variant.sku}: tồn còn ${result.variant.stockQty}.`,
      );
      setReason('');
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể điều chỉnh tồn kho.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 32 }}>Kho hàng</h1>
        <MutedText style={{ marginTop: 8 }}>
          Điều chỉnh tồn có lý do, xem biến động và SKU dưới ngưỡng (
          {threshold}).
        </MutedText>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}
      {loading ? <MutedText style={{ marginTop: 8 }}>Đang tải...</MutedText> : null}

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Điều chỉnh tồn</h2>
        <form onSubmit={(event) => void handleAdjust(event)} style={formStyle}>
          <label style={labelStyle}>
            Variant ID
            <VariantPicker value={variantId} onChange={setVariantId} />
          </label>
          <label style={labelStyle}>
            Số lượng (+ nhập / − xuất)
            <Input
              type="number"
              value={qtyDelta}
              onChange={(event) => setQtyDelta(Number(event.target.value))}
              required
            />
          </label>
          <label style={labelStyle}>
            Lý do
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Kiểm kê / nhập hàng / hỏng..."
            />
          </label>
          <Button type="submit" disabled={saving} style={{ justifySelf: 'start' }}>
            {saving ? 'Đang lưu...' : 'Ghi sổ kho'}
          </Button>
        </form>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Sắp hết hàng</h2>
        {lowStock.length === 0 ? (
          <MutedText style={{ marginTop: 8 }}>Không có SKU dưới ngưỡng.</MutedText>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>SKU</TableHeaderCell>
                <TableHeaderCell>Tên</TableHeaderCell>
                <TableHeaderCell>Tồn</TableHeaderCell>
                <TableHeaderCell>Thao tác</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {lowStock.map((variant) => (
                <TableRow key={variant.id}>
                  <TableCell>{variant.sku}</TableCell>
                  <TableCell>{variant.title}</TableCell>
                  <TableCell>{variant.stockQty}</TableCell>
                  <TableCell>
                    <Button variant="link" onClick={() => setVariantId(variant.id)}>
                      Chọn để điều chỉnh
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Biến động gần đây</h2>
        {movements.length === 0 ? (
          <MutedText style={{ marginTop: 8 }}>Chưa có giao dịch kho.</MutedText>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Thời điểm</TableHeaderCell>
                <TableHeaderCell>Loại</TableHeaderCell>
                <TableHeaderCell>Δ</TableHeaderCell>
                <TableHeaderCell>Sau</TableHeaderCell>
                <TableHeaderCell>Lý do</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {movements.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {new Date(row.createdAt).toLocaleString('vi-VN')}
                  </TableCell>
                  <TableCell>{row.movementType}</TableCell>
                  <TableCell>{row.qtyDelta}</TableCell>
                  <TableCell>{row.stockAfter}</TableCell>
                  <TableCell>{row.reason ?? '—'}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}

function getApiErrorMessage(err: unknown, fallback: string) {
  if (err instanceof ApiClientError) {
    return err.message || fallback;
  }
  if (err instanceof Error) {
    return err.message || fallback;
  }
  return fallback;
}

const pageStyle: CSSProperties = {
  maxWidth: 960,
  margin: '0 auto',
  padding: '28px 20px 48px',
};

const sectionStyle: CSSProperties = {
  marginTop: 28,
};

const sectionTitleStyle: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 20,
};

const formStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  maxWidth: 480,
};

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 14,
};
