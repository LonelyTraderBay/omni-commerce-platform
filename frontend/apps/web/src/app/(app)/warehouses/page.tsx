'use client';

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  ApiClientError,
  createWarehouse,
  getWarehouseStock,
  listWarehouses,
  transferWarehouseStock,
  type Warehouse,
  type WarehouseStock,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import { VariantPicker } from '../../../components/variant-picker';
import {
  Button,
  colorBackgroundCard,
  colorBorder,
  colorBorderStrong,
  colorPrimary,
  colorTextMuted,
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

export default function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('');
  const [stock, setStock] = useState<WarehouseStock[]>([]);
  const [newWarehouseName, setNewWarehouseName] = useState('');
  const [newWarehouseCode, setNewWarehouseCode] = useState('');
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (preferredWarehouseId?: string) => {
      setLoading(true);
      setError(null);
      try {
        const nextWarehouses = await listWarehouses();
        const nextSelectedId =
          preferredWarehouseId ||
          selectedWarehouseId ||
          nextWarehouses[0]?.id ||
          '';
        setWarehouses(nextWarehouses);
        setSelectedWarehouseId(nextSelectedId);
        setFromWarehouseId((current) => current || nextWarehouses[0]?.id || '');
        setToWarehouseId(
          (current) =>
            current ||
            nextWarehouses.find((warehouse) => warehouse.id !== nextWarehouses[0]?.id)
              ?.id ||
            '',
        );

        if (nextSelectedId) {
          const stockResult = await getWarehouseStock(nextSelectedId);
          setStock(stockResult.stock);
        } else {
          setStock([]);
        }
      } catch (err) {
        setError(getApiErrorMessage(err, 'Không thể tải danh sách kho.'));
      } finally {
        setLoading(false);
      }
    },
    [selectedWarehouseId],
  );

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

  async function handleSelectWarehouse(warehouseId: string) {
    setSelectedWarehouseId(warehouseId);
    await load(warehouseId);
  }

  async function handleCreateWarehouse(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const created = await createWarehouse({
        name: newWarehouseName.trim(),
        code: newWarehouseCode.trim(),
      });
      setMessage(`Đã tạo kho ${created.name}.`);
      setNewWarehouseName('');
      setNewWarehouseCode('');
      await load(created.id);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tạo kho.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTransfer(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const result = await transferWarehouseStock({
        fromWarehouseId,
        toWarehouseId,
        variantId: variantId.trim(),
        qty,
        reason: reason.trim() || undefined,
      });
      setMessage(
        `Đã chuyển ${qty} ${result.variant.sku}. Tồn tổng còn ${result.variant.stockQty}.`,
      );
      setReason('');
      await load(selectedWarehouseId || fromWarehouseId);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể chuyển kho.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 32 }}>Kho chi nhánh</h1>
        <MutedText style={{ marginTop: 8 }}>
          Quản lý nhiều kho trong một tổ chức, xem tồn theo kho và chuyển hàng
          có ghi sổ.
        </MutedText>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}
      {loading ? <MutedText style={{ marginTop: 8 }}>Đang tải...</MutedText> : null}

      <section style={gridStyle}>
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Danh sách kho</h2>
          {warehouses.length === 0 ? (
            <MutedText style={{ marginTop: 8 }}>Chưa có kho.</MutedText>
          ) : (
            <div style={cardListStyle}>
              {warehouses.map((warehouse) => (
                <button
                  key={warehouse.id}
                  type="button"
                  onClick={() => void handleSelectWarehouse(warehouse.id)}
                  style={{
                    ...warehouseButtonStyle,
                    borderColor:
                      warehouse.id === selectedWarehouseId ? colorPrimary : colorBorder,
                  }}
                >
                  <strong>{warehouse.name}</strong>
                  <span style={mutedItemStyle}>
                    {warehouse.code}
                    {warehouse.isDefault ? ' · mặc định' : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Tạo kho mới</h2>
          <form onSubmit={(event) => void handleCreateWarehouse(event)} style={formStyle}>
            <label style={labelStyle}>
              Tên kho
              <Input
                value={newWarehouseName}
                onChange={(event) => setNewWarehouseName(event.target.value)}
                placeholder="Kho quận 7"
                required
              />
            </label>
            <label style={labelStyle}>
              Mã kho
              <Input
                value={newWarehouseCode}
                onChange={(event) => setNewWarehouseCode(event.target.value)}
                placeholder="Q7"
                required
              />
            </label>
            <Button
              type="submit"
              disabled={saving}
              style={{ alignSelf: 'end', justifySelf: 'start' }}
            >
              {saving ? 'Đang lưu...' : 'Tạo kho'}
            </Button>
          </form>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Chuyển kho</h2>
        <form onSubmit={(event) => void handleTransfer(event)} style={transferFormStyle}>
          <label style={labelStyle}>
            Từ kho
            <select
              value={fromWarehouseId}
              onChange={(event) => setFromWarehouseId(event.target.value)}
              style={selectStyle}
              required
            >
              <option value="">Chọn kho xuất</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name} ({warehouse.code})
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Đến kho
            <select
              value={toWarehouseId}
              onChange={(event) => setToWarehouseId(event.target.value)}
              style={selectStyle}
              required
            >
              <option value="">Chọn kho nhập</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name} ({warehouse.code})
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Variant ID
            <VariantPicker value={variantId} onChange={setVariantId} />
          </label>
          <label style={labelStyle}>
            Số lượng
            <Input
              type="number"
              min={1}
              value={qty}
              onChange={(event) => setQty(Number(event.target.value))}
              required
            />
          </label>
          <label style={labelStyle}>
            Lý do
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Điều phối chi nhánh / cân kho..."
            />
          </label>
          <Button
            type="submit"
            disabled={saving}
            style={{ alignSelf: 'end', justifySelf: 'start' }}
          >
            {saving ? 'Đang chuyển...' : 'Chuyển kho'}
          </Button>
        </form>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Tồn trong kho đang chọn</h2>
        {stock.length === 0 ? (
          <MutedText style={{ marginTop: 8 }}>Kho này chưa có tồn SKU.</MutedText>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>SKU</TableHeaderCell>
                <TableHeaderCell>Tên</TableHeaderCell>
                <TableHeaderCell>Tồn kho này</TableHeaderCell>
                <TableHeaderCell>Tồn tổng</TableHeaderCell>
                <TableHeaderCell>Thao tác</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {stock.map((row) => (
                <TableRow key={`${row.warehouseId}:${row.variantId}`}>
                  <TableCell>{row.variant?.sku ?? row.variantId}</TableCell>
                  <TableCell>{row.variant?.title ?? '—'}</TableCell>
                  <TableCell>{row.qty}</TableCell>
                  <TableCell>{row.variant?.stockQty ?? '—'}</TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      onClick={() => {
                        setVariantId(row.variantId);
                        setFromWarehouseId(row.warehouseId);
                      }}
                    >
                      Chọn để chuyển
                    </Button>
                  </TableCell>
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
  maxWidth: 1040,
  margin: '0 auto',
  padding: '28px 20px 48px',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gap: 24,
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
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
  maxWidth: 420,
};

const transferFormStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
};

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 14,
};

// No shared `Select` primitive exists yet, so the native <select>s keep a
// local style, just with the border literal swapped for its token.
const selectStyle: CSSProperties = {
  padding: '10px 12px',
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: 8,
  fontSize: 15,
};

const cardListStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
};

const warehouseButtonStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorder}`,
  borderRadius: 10,
  cursor: 'pointer',
  display: 'grid',
  gap: 4,
  padding: 12,
  textAlign: 'left',
};

const mutedItemStyle: CSSProperties = { color: colorTextMuted };
