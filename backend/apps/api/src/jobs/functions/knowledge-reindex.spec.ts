import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeReindexJobService,
  type SupabaseLike,
} from "./knowledge-reindex";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PRODUCT_ID = "22222222-2222-2222-2222-222222222222";

function mockSupabase(input: { deleted?: boolean } = {}) {
  const client = {
    from(table: string) {
      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            maybeSingle: async () => ({
              data: input.deleted
                ? {
                    id: PRODUCT_ID,
                    org_id: ORG_ID,
                    title: "T-shirt",
                    description: null,
                    status: "archived",
                    attrs_json: {},
                    deleted_at: "2026-07-24T10:00:00.000Z",
                  }
                : {
                    id: PRODUCT_ID,
                    org_id: ORG_ID,
                    title: "T-shirt",
                    description: "Cotton",
                    status: "active",
                    attrs_json: { color: "black" },
                    deleted_at: null,
                  },
              error: null,
            }),
            order: async () => ({
              data:
                table === "product_variants"
                  ? [
                      {
                        sku: "TS-BLK-L",
                        title: "Black / L",
                        price_vnd: "120000",
                        stock_qty: 5,
                        attrs_json: { size: "L" },
                      },
                    ]
                  : [],
              error: null,
            }),
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseLike;

  return client;
}

describe("KnowledgeReindexJobService", () => {
  it("posts a product document to the AI reindex endpoint", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, chunksWritten: 1 }),
      text: async () => "",
    }));
    const service = new KnowledgeReindexJobService({
      supabase: mockSupabase(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: {
        AI_BASE_URL: "https://ai.example.test",
        SERVICE_M2M_KEY: "correct-service-key",
      },
    });

    await expect(
      service.reindex({
        orgId: ORG_ID,
        sourceType: "product",
        sourceId: PRODUCT_ID,
      }),
    ).resolves.toEqual({ ok: true, chunksWritten: 1 });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://ai.example.test/internal/v1/reindex",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": "correct-service-key",
        },
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      orgId: ORG_ID,
      sourceType: "product",
      sourceId: PRODUCT_ID,
    });
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].content).toContain("Title: T-shirt");
    expect(body.documents[0].content).toContain("SKU TS-BLK-L");
  });

  it("sends an empty document list when the source was deleted", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, chunksWritten: 0 }),
      text: async () => "",
    }));
    const service = new KnowledgeReindexJobService({
      supabase: mockSupabase({ deleted: true }),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: {
        AI_BASE_URL: "https://ai.example.test",
        SERVICE_M2M_KEY: "correct-service-key",
      },
    });

    await service.reindex({
      orgId: ORG_ID,
      sourceType: "product",
      sourceId: PRODUCT_ID,
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.documents).toEqual([]);
  });
});
