import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "../../config/env";
import { inngest } from "../inngest.client";

export type SupabaseLike = Pick<SupabaseClient, "from">;
export type JsonObject = Record<string, unknown>;

type FetchLike = typeof fetch;
type SourceType = "product";

type KnowledgeReindexInput = JsonObject & {
  orgId?: unknown;
  sourceType?: unknown;
  sourceId?: unknown;
};

type ProductRow = {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: string;
  attrs_json: JsonObject;
  deleted_at: string | null;
};

type VariantRow = {
  sku: string;
  title: string;
  price_vnd: string | number;
  stock_qty: number;
  attrs_json: JsonObject;
};

type KnowledgeDocument = {
  id: string;
  content: string;
};

type ServiceEnv = {
  AI_BASE_URL: string;
  SERVICE_M2M_KEY: string;
};

type KnowledgeReindexJobOptions = {
  env?: ServiceEnv;
  fetchFn?: FetchLike;
  supabase?: SupabaseLike;
};

const PRODUCT_SELECT =
  "id, org_id, title, description, status, attrs_json, deleted_at";
const VARIANT_SELECT = "sku, title, price_vnd, stock_qty, attrs_json";

export class KnowledgeReindexJobService {
  private readonly env: ServiceEnv;
  private readonly fetchFn: FetchLike;
  private readonly supabase: SupabaseLike;

  constructor(options: KnowledgeReindexJobOptions = {}) {
    this.env = options.env ?? loadEnv();
    this.fetchFn = options.fetchFn ?? fetch;
    this.supabase = options.supabase ?? createSupabaseServiceClient();
  }

  async reindex(input: KnowledgeReindexInput) {
    const event = parseReindexEvent(input);
    const documents = await this.loadDocuments(event);
    const response = await this.fetchFn(`${this.env.AI_BASE_URL}/internal/v1/reindex`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": this.env.SERVICE_M2M_KEY,
      },
      body: JSON.stringify({
        orgId: event.orgId,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        documents,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AI knowledge reindex failed: ${response.status} ${body}`);
    }

    return response.json();
  }

  private async loadDocuments(input: {
    orgId: string;
    sourceType: SourceType;
    sourceId: string;
  }) {
    if (input.sourceType === "product") {
      return this.loadProductDocument(input.orgId, input.sourceId);
    }

    return [];
  }

  private async loadProductDocument(orgId: string, productId: string) {
    const { data: product, error: productError } = await this.supabase
      .from("products")
      .select(PRODUCT_SELECT)
      .eq("id", productId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (productError) {
      throwReindexError(productError, "Could not read product for reindex");
    }
    if (!product || (product as ProductRow).deleted_at) {
      return [];
    }

    const { data: variants, error: variantsError } = await this.supabase
      .from("product_variants")
      .select(VARIANT_SELECT)
      .eq("org_id", orgId)
      .eq("product_id", productId)
      .order("sku", { ascending: true });

    if (variantsError) {
      throwReindexError(variantsError, "Could not read product variants for reindex");
    }

    return [
      {
        id: productId,
        content: productToKnowledgeText(
          product as ProductRow,
          (variants ?? []) as VariantRow[],
        ),
      },
    ];
  }
}

export const knowledgeReindex = inngest.createFunction(
  { id: "knowledge-reindex", triggers: { event: "knowledge/reindex" } },
  async ({ event }) => {
    const service = new KnowledgeReindexJobService();
    return service.reindex((event.data ?? {}) as KnowledgeReindexInput);
  },
);

function parseReindexEvent(input: KnowledgeReindexInput) {
  const orgId = toUuid(input.orgId, "orgId");
  const sourceId = toUuid(input.sourceId, "sourceId");
  if (input.sourceType !== "product") {
    throw new Error("knowledge/reindex requires sourceType product");
  }
  const sourceType: SourceType = "product";

  return { orgId, sourceType, sourceId };
}

function productToKnowledgeText(product: ProductRow, variants: VariantRow[]) {
  const lines = [
    "Product",
    `Title: ${product.title}`,
    `Status: ${product.status}`,
    product.description ? `Description: ${product.description}` : undefined,
    objectHasKeys(product.attrs_json)
      ? `Attributes JSON: ${stableJson(product.attrs_json)}`
      : undefined,
  ].filter(Boolean) as string[];

  if (variants.length > 0) {
    lines.push("Variants:");
    for (const variant of variants) {
      const attrs = objectHasKeys(variant.attrs_json)
        ? ` | Attributes JSON: ${stableJson(variant.attrs_json)}`
        : "";
      lines.push(
        `- SKU ${variant.sku} | Title ${variant.title} | Price VND ${variant.price_vnd} | Stock ${variant.stock_qty}${attrs}`,
      );
    }
  }

  return lines.join("\n");
}

function toUuid(value: unknown, fieldName: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`knowledge/reindex requires UUID ${fieldName}`);
  }

  return value;
}

function objectHasKeys(value: JsonObject) {
  return Object.keys(value).length > 0;
}

function stableJson(value: JsonObject) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
    );
  }

  return value;
}

function throwReindexError(
  error: { code?: string; message?: string },
  message: string,
): never {
  throw new Error(`${message}: ${error.message ?? error.code ?? "unknown"}`);
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
