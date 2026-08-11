'use client';

import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  ApiClientError,
  createSupplier,
  listSuppliers,
  type Supplier,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
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

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [name, setName] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [addressText, setAddressText] = useState('');
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
      setSuppliers(await listSuppliers());
    } catch (err) {
      setError(apiError(err, 'Không thể tải nhà cung cấp.'));
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
      const supplier = await createSupplier({
        name: name.trim(),
        taxCode: taxCode.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        addressText: addressText.trim() || undefined,
      });
      setMessage(`Đã tạo nhà cung cấp ${supplier.name}.`);
      setName('');
      setTaxCode('');
      setPhone('');
      setEmail('');
      setAddressText('');
      await load();
    } catch (err) {
      setError(apiError(err, 'Không thể tạo nhà cung cấp.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={{ margin: 0, fontSize: 32 }}>Nhà cung cấp</h1>
        <MutedText>Danh bạ supplier dùng cho purchase order và nhập kho.</MutedText>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <Card title="Tạo supplier" style={{ marginTop: 24 }}>
        <form onSubmit={(event) => void handleCreate(event)} style={formStyle}>
          <label style={labelStyle}>
            Tên
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label style={labelStyle}>
            Mã số thuế
            <Input value={taxCode} onChange={(event) => setTaxCode(event.target.value)} />
          </label>
          <label style={labelStyle}>
            Điện thoại
            <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
          </label>
          <label style={labelStyle}>
            Email
            <Input value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label style={labelStyle}>
            Địa chỉ
            <Input value={addressText} onChange={(event) => setAddressText(event.target.value)} />
          </label>
          <Button type="submit" disabled={saving} style={{ alignSelf: 'end' }}>
            {saving ? 'Đang lưu...' : 'Tạo supplier'}
          </Button>
        </form>
      </Card>

      <Card title="Danh sách" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText>Đang tải...</MutedText>
        ) : suppliers.length === 0 ? (
          <MutedText>Chưa có nhà cung cấp.</MutedText>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Tên</TableHeaderCell>
                <TableHeaderCell>MST</TableHeaderCell>
                <TableHeaderCell>Liên hệ</TableHeaderCell>
                <TableHeaderCell>Địa chỉ</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {suppliers.map((supplier) => (
                <TableRow key={supplier.id}>
                  <TableCell>{supplier.name}</TableCell>
                  <TableCell>{supplier.taxCode ?? '—'}</TableCell>
                  <TableCell>{supplier.phone ?? supplier.email ?? '—'}</TableCell>
                  <TableCell>{supplier.addressText ?? '—'}</TableCell>
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

const pageStyle: CSSProperties = { maxWidth: 1040, margin: '0 auto', padding: '28px 20px 48px' };
const formStyle: CSSProperties = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' };
const labelStyle: CSSProperties = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 700 };
