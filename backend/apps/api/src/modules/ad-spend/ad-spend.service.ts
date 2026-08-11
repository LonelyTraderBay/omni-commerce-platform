import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv } from '../../config/env';
import {
  AdSpendRowInputSchema,
  type AdSpendRowInput,
  type AdSpendSummaryQuery,
  type ImportAdSpendBody,
  type ListAdSpendQuery,
} from './dto';

export const AD_SPEND_SUPABASE = Symbol('AD_SPEND_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

type SupabaseError = {
  code?: string;
  message?: string;
};

type AdSpendRow = {
  id: string;
  org_id: string;
  source: 'meta_ads' | 'csv' | string;
  date: string;
  campaign_name: string;
  amount_vnd: string | number;
  external_id: string | null;
  created_at: string;
};

const AD_SPEND_SELECT =
  'id, org_id, source, date, campaign_name, amount_vnd, external_id, created_at';
const MAX_IMPORT_ROWS = 1000;

@Injectable()
export class AdSpendService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(AD_SPEND_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async importRows(orgId: string, body: ImportAdSpendBody) {
    const rows = normalizeImportRows(body);
    if (rows.length === 0) {
      throw new BadRequestException({
        code: 'ad_spend_empty_import',
        message: 'No ad spend rows were found',
      });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        code: 'ad_spend_import_too_large',
        message: `At most ${MAX_IMPORT_ROWS} ad spend rows can be imported at once`,
      });
    }

    const insertRows = rows.map((row) => ({
      org_id: orgId,
      source: row.source,
      date: row.date,
      campaign_name: row.campaignName,
      amount_vnd: row.amountVnd,
      external_id: row.externalId,
    }));

    const { data, error } = await this.supabase
      .from('ad_spend')
      .insert(insertRows)
      .select(AD_SPEND_SELECT);

    if (error) {
      throwAdSpendError(error, 'Could not import ad spend');
    }

    return {
      importedCount: insertRows.length,
      adSpend: ((data ?? []) as AdSpendRow[]).map(mapAdSpend),
    };
  }

  async list(orgId: string, query: ListAdSpendQuery) {
    let builder = this.supabase
      .from('ad_spend')
      .select(AD_SPEND_SELECT)
      .eq('org_id', orgId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(query.limit);

    builder = applyDateRange(builder, query);

    const { data, error } = await builder;
    if (error) {
      throwAdSpendError(error, 'Could not list ad spend');
    }

    return {
      adSpend: ((data ?? []) as AdSpendRow[]).map(mapAdSpend),
    };
  }

  async summary(orgId: string, query: AdSpendSummaryQuery) {
    const rows = await this.loadForSummary(orgId, query);
    const byDay = new Map<string, bigint>();
    let total = 0n;

    for (const row of rows) {
      const amount = toBigintVnd(row.amount_vnd);
      total += amount;
      byDay.set(row.date, (byDay.get(row.date) ?? 0n) + amount);
    }

    return {
      totalVnd: total.toString(),
      days: [...byDay.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, amount]) => ({
          day,
          amountVnd: amount.toString(),
        })),
    };
  }

  private async loadForSummary(orgId: string, query: AdSpendSummaryQuery) {
    let builder = this.supabase
      .from('ad_spend')
      .select(AD_SPEND_SELECT)
      .eq('org_id', orgId)
      .order('date', { ascending: true })
      .limit(10_000);

    builder = applyDateRange(builder, query);

    const { data, error } = await builder;
    if (error) {
      throwAdSpendError(error, 'Could not summarize ad spend');
    }

    return (data ?? []) as AdSpendRow[];
  }
}

function normalizeImportRows(body: ImportAdSpendBody): AdSpendRowInput[] {
  return [
    ...(body.rows ?? []),
    ...(body.csv?.trim() ? parseCsvRows(body.csv, body.source) : []),
  ];
}

function parseCsvRows(csv: string, source: 'meta_ads' | 'csv'): AdSpendRowInput[] {
  const records = parseCsv(csv).filter((row) =>
    row.some((cell) => cell.trim() !== ''),
  );
  if (records.length === 0) {
    return [];
  }

  const headers = records[0].map(normalizeHeader);
  const dateIndex = headers.indexOf('date');
  const campaignIndex = firstIndex(headers, ['campaign', 'campaign_name']);
  const amountIndex = firstIndex(headers, ['amount_vnd', 'amount']);
  const externalIdIndex = firstIndex(headers, ['external_id', 'externalid']);

  if (dateIndex === -1 || campaignIndex === -1 || amountIndex === -1) {
    throw new BadRequestException({
      code: 'ad_spend_invalid_csv',
      message: 'CSV must include date,campaign,amount_vnd headers',
    });
  }

  return records.slice(1).map((record, index) => {
    const parsed = AdSpendRowInputSchema.safeParse({
      date: record[dateIndex],
      campaign: record[campaignIndex],
      amount_vnd: record[amountIndex],
      source,
      external_id:
        externalIdIndex === -1
          ? undefined
          : record[externalIdIndex]?.trim() || undefined,
    });

    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ad_spend_invalid_csv_row',
        message: `CSV row ${index + 2} is invalid`,
        issues: parsed.error.issues,
      });
    }

    return parsed.data;
  });
}

function parseCsv(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  rows.push(row);
  return rows;
}

function firstIndex(headers: string[], candidates: string[]) {
  return candidates.reduce((found, candidate) => {
    if (found !== -1) {
      return found;
    }
    return headers.indexOf(candidate);
  }, -1);
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function applyDateRange<
  T extends {
    gte: (column: string, value: string) => T;
    lte: (column: string, value: string) => T;
  },
>(
  builder: T,
  query: { from?: string; to?: string },
) {
  let next = builder;
  if (query.from) {
    next = next.gte('date', query.from);
  }
  if (query.to) {
    next = next.lte('date', query.to);
  }
  return next;
}

function mapAdSpend(row: AdSpendRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    source: row.source,
    date: row.date,
    campaignName: row.campaign_name,
    amountVnd: String(row.amount_vnd),
    externalId: row.external_id,
    createdAt: row.created_at,
  };
}

function toBigintVnd(value: string | number | unknown) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throwInvalidMoney();
    }
    return BigInt(value);
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }

  throwInvalidMoney();
}

function throwInvalidMoney(): never {
  throw new BadRequestException({
    code: 'invalid_money_amount',
    message: 'Money amount must be a non-negative integer VND value',
  });
}

function throwAdSpendError(error: SupabaseError, message: string): never {
  if (error.code === '23505') {
    throw new BadRequestException({
      code: 'ad_spend_external_id_conflict',
      message: error.message ?? 'Ad spend external_id already exists',
    });
  }

  throw new InternalServerErrorException({
    code: 'ad_spend_failed',
    message: error.message ?? message,
  });
}

function createSupabaseServiceClient() {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
