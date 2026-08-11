'use client';

import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  ApiClientError,
  issueEinvoice,
  listEinvoiceJobs,
  type EinvoiceJob,
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

export default function EinvoicePage() {
  const [jobs, setJobs] = useState<EinvoiceJob[]>([]);
  const [orderId, setOrderId] = useState('');
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
      setJobs(await listEinvoiceJobs());
    } catch (err) {
      setError(apiError(err, 'Không thể tải job hóa đơn điện tử.'));
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

  async function handleIssue(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const job = await issueEinvoice(orderId.trim());
      setMessage(`Đã issue stub e-invoice: ${job.status}.`);
      setOrderId('');
      await load();
    } catch (err) {
      setError(apiError(err, 'Không thể issue hóa đơn điện tử.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={{ margin: 0, fontSize: 32 }}>Hóa đơn điện tử</h1>
        <MutedText>
          Stub / http_sandbox engineering path. Live tax provider vẫn AMBER. Xem{' '}
          docs/ops/einvoice-providers.md.
        </MutedText>
      </header>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <Card title="Issue thủ công" style={{ marginTop: 24 }}>
        <form onSubmit={(event) => void handleIssue(event)} style={formStyle}>
          <label style={labelStyle}>
            Order ID đã done
            <Input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              required
              style={{ minWidth: 360 }}
            />
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? 'Đang issue...' : 'Issue stub'}
          </Button>
        </form>
      </Card>

      <Card title="Jobs" style={{ marginTop: 24 }}>
        {loading ? (
          <MutedText>Đang tải...</MutedText>
        ) : jobs.length === 0 ? (
          <MutedText>Chưa có e-invoice job.</MutedText>
        ) : (
          <Table style={{ minWidth: 880 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Order</TableHeaderCell>
                <TableHeaderCell>Provider</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Attempts</TableHeaderCell>
                <TableHeaderCell>Last error</TableHeaderCell>
                <TableHeaderCell>Sent</TableHeaderCell>
              </TableRow>
            </TableHead>
            <tbody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{job.orderId}</TableCell>
                  <TableCell>{job.provider}</TableCell>
                  <TableCell>{job.status}</TableCell>
                  <TableCell>{job.attempts}</TableCell>
                  <TableCell>{job.lastError ?? '—'}</TableCell>
                  <TableCell>{job.sentAt ? new Date(job.sentAt).toLocaleString('vi-VN') : '—'}</TableCell>
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
const formStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' };
const labelStyle: CSSProperties = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 700 };
