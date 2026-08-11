import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  KnowledgeIngestService,
  parseReplaceKnowledgeChunksBody,
  parseRetrieveKnowledgeChunksBody,
  type SupabaseLike,
} from "./knowledge-ingest.service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_ID = "22222222-2222-2222-2222-222222222222";

type SupabaseCall = {
  op: string;
  table?: string;
  fn?: string;
  args?: unknown;
  values?: unknown;
  field?: string;
  value?: unknown;
};

function mockSupabase(input: { productFound?: boolean } = {}) {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(values: string) {
          calls.push({ op: "select", table, values });
          const query = {
            eq(field: string, value: unknown) {
              calls.push({ op: "eq", field, value });
              return query;
            },
            is(field: string, value: unknown) {
              calls.push({ op: "is", field, value });
              return query;
            },
            maybeSingle: async () => ({
              data: input.productFound === false ? null : { id: SOURCE_ID },
              error: null,
            }),
          };
          return query;
        },
      };
    },
    rpc(fn: string, args: unknown) {
      calls.push({ op: "rpc", fn, args });
      return {
        data: { ok: true, deletedOld: true, inserted: 1 },
        error: null,
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function mockSupabaseForFaq() {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      calls.push({ op: "unexpected_from", table });
      return {};
    },
    rpc(fn: string, args: unknown) {
      calls.push({ op: "rpc", fn, args });
      return {
        data: { ok: true, deletedOld: true, inserted: 0 },
        error: null,
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function mockSupabaseForRetrieve() {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      calls.push({ op: "unexpected_from", table });
      return {};
    },
    rpc(fn: string, args: unknown) {
      calls.push({ op: "rpc", fn, args });
      return {
        data: [
          {
            source_type: "product",
            source_id: SOURCE_ID,
            chunk_index: 0,
            content: "Title: T-shirt",
            similarity: 0.91,
          },
        ],
        error: null,
      };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

function mockSupabaseWithOwnershipError() {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(values: string) {
          calls.push({ op: "select", table, values });
          const query = {
            eq() {
              return query;
            },
            is() {
              return query;
            },
            maybeSingle: async () => ({ data: null, error: null }),
          };
          return query;
        },
      };
    },
    rpc(fn: string, args: unknown) {
      calls.push({ op: "rpc", fn, args });
      return { data: null, error: null };
    },
  } as unknown as SupabaseLike;

  return { calls, client };
}

describe("KnowledgeIngestService", () => {
  it("verifies product ownership and replaces chunks via RPC", async () => {
    const { calls, client } = mockSupabase();
    const service = new KnowledgeIngestService(client);
    const embedding = Array.from({ length: 768 }, () => 0.01);

    await expect(
      service.replaceChunks({
        orgId: ORG_ID,
        sourceType: "product",
        sourceId: SOURCE_ID,
        chunks: [
          {
            chunkIndex: 0,
            content: "Product\nTitle: T-shirt",
            contentHash: "abc123",
            embedding,
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1 });

    expect(calls).toContainEqual({
      op: "select",
      table: "products",
      values: "id",
    });
    expect(calls).toContainEqual({ op: "eq", field: "id", value: SOURCE_ID });
    expect(calls).toContainEqual({
      op: "eq",
      field: "org_id",
      value: ORG_ID,
    });
    expect(calls).toContainEqual({
      op: "is",
      field: "deleted_at",
      value: null,
    });
    expect(calls).toContainEqual({
      op: "rpc",
      fn: "replace_knowledge_chunks",
      args: {
        p_org_id: ORG_ID,
        p_source_type: "product",
        p_source_id: SOURCE_ID,
        p_chunks: [
          {
            chunk_index: 0,
            content: "Product\nTitle: T-shirt",
            content_hash: "abc123",
            embedding: `[${embedding.join(",")}]`,
          },
        ],
      },
    });
  });

  it("purges chunks for a soft-deleted product without requiring deleted_at null", async () => {
    const { calls, client } = mockSupabase({ productFound: true });
    const service = new KnowledgeIngestService(client);

    await expect(
      service.replaceChunks({
        orgId: ORG_ID,
        sourceType: "product",
        sourceId: SOURCE_ID,
        chunks: [],
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(calls).not.toContainEqual({
      op: "is",
      field: "deleted_at",
      value: null,
    });
    expect(calls).toContainEqual({
      op: "rpc",
      fn: "replace_knowledge_chunks",
      args: {
        p_org_id: ORG_ID,
        p_source_type: "product",
        p_source_id: SOURCE_ID,
        p_chunks: [],
      },
    });
  });

  it("does not purge chunks when a product is missing from the org", async () => {
    const { calls, client } = mockSupabase({ productFound: false });
    const service = new KnowledgeIngestService(client);

    await expect(
      service.replaceChunks({
        orgId: ORG_ID,
        sourceType: "product",
        sourceId: SOURCE_ID,
        chunks: [],
      }),
    ).rejects.toThrow(NotFoundException);

    expect(calls).not.toContainEqual(
      expect.objectContaining({ op: "rpc" }),
    );
  });

  it("does not replace chunks when a product is missing from the org", async () => {
    const { calls, client } = mockSupabaseWithOwnershipError();
    const service = new KnowledgeIngestService(client);
    const embedding = Array.from({ length: 768 }, () => 0.01);

    await expect(
      service.replaceChunks({
        orgId: ORG_ID,
        sourceType: "product",
        sourceId: SOURCE_ID,
        chunks: [
          {
            chunkIndex: 0,
            content: "Product",
            contentHash: "abc123",
            embedding,
          },
        ],
      }),
    ).rejects.toThrow(NotFoundException);

    expect(calls).not.toContainEqual(
      expect.objectContaining({ op: "rpc" }),
    );
  });

  it("replaces non-product chunks through the RPC without product lookup", async () => {
    const { calls, client } = mockSupabaseForFaq();
    const service = new KnowledgeIngestService(client);

    await expect(
      service.replaceChunks({
        orgId: ORG_ID,
        sourceType: "faq",
        sourceId: SOURCE_ID,
        chunks: [],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 0 });

    expect(calls).toEqual([
      {
        op: "rpc",
        fn: "replace_knowledge_chunks",
        args: {
          p_org_id: ORG_ID,
          p_source_type: "faq",
          p_source_id: SOURCE_ID,
          p_chunks: [],
        },
      },
    ]);
  });

  it("retrieves chunks by org and query embedding via RPC", async () => {
    const { calls, client } = mockSupabaseForRetrieve();
    const service = new KnowledgeIngestService(client);
    const embedding = Array.from({ length: 768 }, () => 0.02);

    await expect(
      service.retrieveChunks({
        orgId: ORG_ID,
        embedding,
        topK: 3,
      }),
    ).resolves.toEqual({
      chunks: [
        {
          sourceType: "product",
          sourceId: SOURCE_ID,
          chunkIndex: 0,
          content: "Title: T-shirt",
          score: 0.91,
        },
      ],
    });

    expect(calls).toEqual([
      {
        op: "rpc",
        fn: "retrieve_knowledge_chunks",
        args: {
          p_org_id: ORG_ID,
          p_embedding: `[${embedding.join(",")}]`,
          p_match_count: 3,
        },
      },
    ]);
  });

  it("rejects embeddings with the wrong dimension", () => {
    expect(() =>
      parseReplaceKnowledgeChunksBody({
        orgId: ORG_ID,
        sourceType: "product",
        sourceId: SOURCE_ID,
        chunks: [
          {
            chunkIndex: 0,
            content: "Product",
            contentHash: "abc123",
            embedding: [0.1],
          },
        ],
      }),
    ).toThrow(BadRequestException);
  });

  it("rejects retrieval embeddings with the wrong dimension", () => {
    expect(() =>
      parseRetrieveKnowledgeChunksBody({
        orgId: ORG_ID,
        embedding: [0.1],
        topK: 5,
      }),
    ).toThrow(BadRequestException);
  });
});
