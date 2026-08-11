'use client';

import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  ApiClientError,
  createPurchaseOrder,
  listPurchaseOrders,
  listSuppliers,
  listWarehouses,
  receivePurchaseOrder,
  updatePurchaseOrderStatus,
  type PurchaseOrder,
  type Supplier,
  type Warehouse,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import { VariantPicker } from '../../../components/variant-picker';
import {
  Button,
  Card,
  colorBorderStrong,
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

export default function PurchaseOrdersPage() {
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [qty, setQty] = useState(1);
  const [unitCostVnd, setUnitCostVnd] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (event?: Event) => {
    if (event && isForeignStorageEvent(event)) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextSuppliers, nextWarehouses, nextPurchaseOrders] = await Promise.all([
        listSuppliers(),
        listWarehouses(),
        listPurchaseOrders(),
      ]);
      setSuppliers(nextSuppliers);
      setWarehouses(nextWarehouses);
      setPurchaseOrders(nextPurchaseOrders);
      setSupplierId((current) => current || nextSuppliers[0]?.id || '');
      setWarehouseId((current) => current || nextWarehouses[0]?.id || '');
    } catch (err) {
      setError(apiError(err, 'Không thể tải PO.'));
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

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const po = await createPurchaseOrder({
        supplierId,
        warehouseId: warehouseId || undefined,
        status: 'draft',
        note: note.trim() || undefined,
        items: [
          {
            variantId: variantId.trim(),
            qty,
            unitCostVnd: unitCostVnd.trim(),
          },
        ],
      });
      setMessage(`Đã tạo PO ${po.id.slice(0, 8)}.`);
      setVariantId('');
      setQty(1);
      setUnitCostVnd('');
      setNote('');
      await load();
    } catch (err) {
      setError(apiError(err, 'Không thể tạo PO.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleStatus(po: PurchaseOrder, status: 'ordered' | 'cancelled') {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await updatePurchaseOrderStatus(po.id, status);
      setMessage(status === 'ordered' ? 'Đã đặt hàng.' : 'Đã hủy PO.');
      await load();
    } catch (err) {
      setError(apiError(err, 'Không thể cập nhật PO.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleReceive(po: PurchaseOrder) {
    const targetWarehouseId = po.warehouseId ?? warehouseId;
    if (!targetWarehouseId) {
      setError('Chọn kho nhận trước khi receive PO.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await receivePurchaseOrder({
        purchaseOrderId: po.id,
        warehouseId: targetWarehouseId,
      });
      setMessage(`Đã nhập kho PO ${po.id.slice(0, 8)}.`);
      await load();
    } catch (err) {
      setError(apiError(err, 'Không thể nhập kho PO.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={{ margin: 0, fontSize: 32 }}>Purchase orders</h1>
        <MutedText>Tạo PO mỏng và receive để ghi inbound ledger vào kho.</MutedText>
      </header>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <Card title="Tạo PO một dòng" style={{ marginTop: 24 }}>
        <form onSubmit={(event) => void handleCreate(event)} style={formStyle}>
          <label style={labelStyle}>
            Supplier
            <select
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              required
              style={selectStyle}
            >
              <option value="">Chọn supplier</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Kho nhận
            <select
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
              style={selectStyle}
            >
              <option value="">Chọn khi receive</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>{warehouse.name} ({warehouse.code})</option>
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
            Giá vốn / đơn vị
            <Input
              value={unitCostVnd}
              onChange={(event) => setUnitCostVnd(event.target.value)}
              required
              pattern="\d+"
            />
          </label>
          <label style={labelStyle}>
            Ghi chú
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <Button type="submit" disabled={saving} style={{ alignSelf: 'end' }}>
            {saving ? 'Đang lưu...' : 'Tạo PO'}
          </Button>
        </form>
      </Card>

      <Card title="Danh sách PO" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText>Đang tải...</MutedText>
        ) : purchaseOrders.length === 0 ? (
          <MutedText>Chưa có PO.</MutedText>
        ) : (
          <Table style={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>PO</TableHeaderCell>
                <TableHeaderCell>Supplier</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Items</TableHeaderCell>
                <TableHeaderCell>Thao tác</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {purchaseOrders.map((po) => (
                <TableRow key={po.id}>
                  <TableCell>{po.id.slice(0, 8)}</TableCell>
                  <TableCell>{po.supplier?.name ?? po.supplierId}</TableCell>
                  <TableCell>{po.status}</TableCell>
                  <TableCell>
                    {po.items.map((item) => `${item.variantId.slice(0, 8)} x${item.qty} @ ${formatVnd(item.unitCostVnd)}`).join(', ')}
                  </TableCell>
                  <TableCell>
                    {po.status === 'draft' ? (
                      <Button
                        variant="link"
                        style={{ marginRight: 8 }}
                        disabled={saving}
                        onClick={() => void handleStatus(po, 'ordered')}
                      >
                        Đặt hàng
                      </Button>
                    ) : null}
                    {po.status === 'draft' || po.status === 'ordered' ? (
                      <Button
                        variant="link"
                        style={{ marginRight: 8 }}
                        disabled={saving}
                        onClick={() => void handleReceive(po)}
                      >
                        Nhập kho
                      </Button>
                    ) : null}
                    {po.status === 'draft' || po.status === 'ordered' ? (
                      <Button
                        variant="danger"
                        style={{ marginRight: 8 }}
                        disabled={saving}
                        onClick={() => void handleStatus(po, 'cancelled')}
                      >
                        Hủy
                      </Button>
                    ) : null}
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

function apiError(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function formatVnd(value: string) {
  return `${value.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

const pageStyle: CSSProperties = { maxWidth: 1120, margin: '0 auto', padding: '28px 20px 48px' };
const formStyle: CSSProperties = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' };
const labelStyle: CSSProperties = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 700 };
// No shared `Select` primitive exists yet, so the native <select>s keep a
// local style, just with the border literal swapped for its token.
const selectStyle: CSSProperties = { border: `1px solid ${colorBorderStrong}`, borderRadius: 8, font: 'inherit', padding: '10px 12px' };
