import type { EinvoiceProviderCode } from './dto';

export type EinvoiceIssueInput = {
  orgId: string;
  orderId: string;
  payload: Record<string, unknown>;
};

export type EinvoiceIssueResult = {
  provider: EinvoiceProviderCode;
  externalId: string;
  sentAt: string;
  /** Optional provider note (e.g. unconfigured sandbox URL). */
  note?: string;
};

export interface EinvoiceProvider {
  issue(input: EinvoiceIssueInput): Promise<EinvoiceIssueResult>;
}

export class StubEinvoiceProvider implements EinvoiceProvider {
  async issue(input: EinvoiceIssueInput): Promise<EinvoiceIssueResult> {
    return {
      provider: 'stub',
      externalId: `stub-${input.orderId.slice(0, 8)}`,
      sentAt: new Date().toISOString(),
    };
  }
}
