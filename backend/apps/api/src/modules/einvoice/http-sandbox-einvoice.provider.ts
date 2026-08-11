import type { EinvoiceProviderCode } from './dto';
import type {
  EinvoiceIssueInput,
  EinvoiceIssueResult,
  EinvoiceProvider,
} from './stub-einvoice.provider';

export const HTTP_SANDBOX_TIMEOUT_MS = 10_000;

export type HttpSandboxEinvoiceConfig = {
  sandboxUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class HttpSandboxEinvoiceProvider implements EinvoiceProvider {
  private readonly sandboxUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpSandboxEinvoiceConfig = {}) {
    this.sandboxUrl = trimEnv(
      config.sandboxUrl !== undefined
        ? config.sandboxUrl
        : process.env.EINVOICE_SANDBOX_URL,
    );
    this.timeoutMs = config.timeoutMs ?? HTTP_SANDBOX_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async issue(input: EinvoiceIssueInput): Promise<EinvoiceIssueResult> {
    if (!this.sandboxUrl) {
      return {
        provider: 'http_sandbox',
        externalId: `http-sandbox-unconfigured-${input.orderId.slice(0, 8)}`,
        sentAt: new Date().toISOString(),
        note: 'EINVOICE_SANDBOX_URL was not configured; returning deterministic stub success',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.sandboxUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: input.orgId,
          orderId: input.orderId,
          ...input.payload,
        }),
        signal: controller.signal,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `http_sandbox provider failed with HTTP ${response.status}`,
        );
      }

      const externalId = await readExternalId(response, input.orderId);
      return {
        provider: 'http_sandbox',
        externalId,
        sentAt: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `http_sandbox provider timed out after ${this.timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function resolveDefaultEinvoiceProvider(
  raw: NodeJS.ProcessEnv = process.env,
): EinvoiceProviderCode {
  const value = trimEnv(raw.EINVOICE_PROVIDER);
  if (value === 'http_sandbox') {
    return 'http_sandbox';
  }
  return 'stub';
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function readExternalId(
  response: Response,
  orderId: string,
): Promise<string> {
  const fallback = `http-sandbox-${orderId.slice(0, 8)}`;
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return fallback;
  }

  try {
    const body = (await response.json()) as Record<string, unknown>;
    const externalId = body.externalId ?? body.id;
    return typeof externalId === 'string' && externalId.length > 0
      ? externalId
      : fallback;
  } catch {
    return fallback;
  }
}
