import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HttpSandboxEinvoiceProvider,
  resolveDefaultEinvoiceProvider,
} from './http-sandbox-einvoice.provider';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';

describe('HttpSandboxEinvoiceProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns deterministic success when EINVOICE_SANDBOX_URL is unset', async () => {
    const fetchImpl = vi.fn();
    const provider = new HttpSandboxEinvoiceProvider({
      sandboxUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.issue({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      payload: { totalVnd: '120000' },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'http_sandbox',
      externalId: 'http-sandbox-unconfigured-22222222',
      note: expect.stringContaining('EINVOICE_SANDBOX_URL was not configured'),
    });
  });

  it('treats HTTP 200 as success and POSTs JSON payload', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ externalId: 'sandbox-ext-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new HttpSandboxEinvoiceProvider({
      sandboxUrl: 'https://sandbox.example.test/einvoice',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.issue({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      payload: { totalVnd: '120000', customerName: 'Nguyen Van A' },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://sandbox.example.test/einvoice');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      totalVnd: '120000',
      customerName: 'Nguyen Van A',
    });
    expect(result).toMatchObject({
      provider: 'http_sandbox',
      externalId: 'sandbox-ext-1',
    });
    expect(result.note).toBeUndefined();
  });

  it('fails with status in message on HTTP 500', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('upstream boom', { status: 500 }),
    );
    const provider = new HttpSandboxEinvoiceProvider({
      sandboxUrl: 'https://sandbox.example.test/einvoice',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.issue({
        orgId: ORG_ID,
        orderId: ORDER_ID,
        payload: { totalVnd: '120000' },
      }),
    ).rejects.toThrow('http_sandbox provider failed with HTTP 500');
  });
});

describe('resolveDefaultEinvoiceProvider', () => {
  it('defaults to stub and honors EINVOICE_PROVIDER=http_sandbox', () => {
    expect(resolveDefaultEinvoiceProvider({})).toBe('stub');
    expect(
      resolveDefaultEinvoiceProvider({ EINVOICE_PROVIDER: 'http_sandbox' }),
    ).toBe('http_sandbox');
    expect(resolveDefaultEinvoiceProvider({ EINVOICE_PROVIDER: 'stub' })).toBe(
      'stub',
    );
  });
});
