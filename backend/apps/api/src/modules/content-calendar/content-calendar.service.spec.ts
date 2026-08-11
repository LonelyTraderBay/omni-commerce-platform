import { describe, expect, it, vi } from 'vitest';

import {
  ContentCalendarService,
  type SupabaseLike,
} from './content-calendar.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '99999999-9999-9999-9999-999999999999';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';
const CREATED_AT = '2026-07-27T12:00:00.000Z';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

describe('ContentCalendarService', () => {
  it('creates calendar items with auto-post stored only and audited', async () => {
    const db = createClient();
    const audit = { writeAudit: vi.fn().mockResolvedValue({}) };
    const service = new ContentCalendarService(db.client, audit);

    const result = await service.createItem({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      body: {
        title: 'Bài sale cuối tuần',
        body: 'Ưu đãi cho khách cũ',
        plannedAt: '2026-07-28T02:00:00.000Z',
        status: 'scheduled',
        channelHint: 'facebook',
        autoPostEnabled: true,
      },
    });

    expect(result.item).toMatchObject({
      orgId: ORG_ID,
      title: 'Bài sale cuối tuần',
      status: 'scheduled',
      autoPostEnabled: true,
    });
    expect(db.tables.content_calendar_items[0]).toMatchObject({
      org_id: ORG_ID,
      auto_post_enabled: true,
    });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'content_calendar.created',
        meta: expect.objectContaining({
          autoPostNote:
            'Stored only. Meta auto-post is intentionally not implemented in Plan G.',
        }),
      }),
    );
  });

  it('lists only current-org items and supports status filtering', async () => {
    const db = createClient({
      content_calendar_items: [
        calendarRow({ id: ITEM_ID, status: 'scheduled' }),
        calendarRow({ org_id: OTHER_ORG_ID, title: 'Other org' }),
        calendarRow({ id: '33333333-3333-3333-3333-333333333333', status: 'idea' }),
      ],
    });
    const service = new ContentCalendarService(db.client, {
      writeAudit: vi.fn(),
    });

    await expect(
      service.listItems(ORG_ID, { status: 'scheduled' }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: ITEM_ID,
          orgId: ORG_ID,
          status: 'scheduled',
        }),
      ],
    });
  });

  it('updates and deletes items through org-scoped filters', async () => {
    const db = createClient({
      content_calendar_items: [calendarRow({ id: ITEM_ID })],
    });
    const audit = { writeAudit: vi.fn().mockResolvedValue({}) };
    const service = new ContentCalendarService(db.client, audit);

    const updated = await service.updateItem({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      itemId: ITEM_ID,
      body: { status: 'posted' },
    });
    expect(updated.item.status).toBe('posted');

    const deleted = await service.deleteItem({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      itemId: ITEM_ID,
    });
    expect(deleted.item.id).toBe(ITEM_ID);
    expect(db.tables.content_calendar_items).toEqual([]);
  });
});

function createClient(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    content_calendar_items: [...(seed.content_calendar_items ?? [])],
  };

  return {
    tables,
    client: {
      from(table: string) {
        if (!tables[table]) {
          tables[table] = [];
        }
        return new Query(tables, table);
      },
    } as unknown as SupabaseLike,
  };
}

function calendarRow(overrides: Row = {}) {
  return {
    id: `calendar-${Math.random()}`,
    org_id: ORG_ID,
    title: 'Post idea',
    body: null,
    planned_at: '2026-07-28T02:00:00.000Z',
    status: 'idea',
    channel_hint: null,
    auto_post_enabled: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

class Query {
  private filters: Array<{ column: string; value: unknown }> = [];
  private insertValues: Row[] | null = null;
  private updateValues: Row | null = null;
  private deleteRequested = false;
  private limitCount: number | null = null;
  private maybeSingleRequested = false;
  private singleRequested = false;
  private orderBy: Array<{ column: string; ascending: boolean }> = [];

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderBy.push({ column, ascending: options.ascending ?? true });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  insert(values: Row | Row[]) {
    this.insertValues = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Row) {
    this.updateValues = values;
    return this;
  }

  delete() {
    this.deleteRequested = true;
    return this;
  }

  single() {
    this.singleRequested = true;
    return this;
  }

  maybeSingle() {
    this.maybeSingleRequested = true;
    return this;
  }

  then(resolve: (value: { data?: Row | Row[] | null; error: null }) => void) {
    const data = this.execute();
    if (this.singleRequested || this.maybeSingleRequested) {
      resolve({ data: data[0] ?? null, error: null });
      return;
    }
    resolve({ data, error: null });
  }

  private execute() {
    if (this.insertValues) {
      const inserted = this.insertValues.map((value) => ({
        id: `calendar-${this.tables[this.table].length + 1}`,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        ...value,
      }));
      this.tables[this.table].push(...inserted);
      return inserted;
    }

    const rows = this.applyFilters();
    if (this.updateValues) {
      for (const row of rows) {
        Object.assign(row, this.updateValues);
      }
      return rows;
    }

    if (this.deleteRequested) {
      this.tables[this.table] = this.tables[this.table].filter(
        (row) => !rows.includes(row),
      );
      return rows;
    }

    return rows;
  }

  private applyFilters() {
    let rows = this.tables[this.table].filter((row) =>
      this.filters.every((filter) => row[filter.column] === filter.value),
    );

    for (const order of this.orderBy.slice().reverse()) {
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[order.column]).localeCompare(
          String(right[order.column]),
        );
        return order.ascending ? comparison : -comparison;
      });
    }

    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    return rows;
  }
}
