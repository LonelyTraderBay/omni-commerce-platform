import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { DEFAULT_AI_DRAFT_MAX_AMOUNT_VND, loadEnv } from '../../config/env';

export const AI_TOOLS_SUPABASE = Symbol('AI_TOOLS_SUPABASE');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;

const PRODUCT_SELECT =
  'id, org_id, title, description, status, attrs_json, created_at, updated_at, deleted_at';
const VARIANT_SELECT =
  'id, org_id, product_id, sku, title, price_vnd, stock_qty, attrs_json, created_at, updated_at';
const PRODUCT_WITH_VARIANTS_SELECT = `${PRODUCT_SELECT}, variants:product_variants(${VARIANT_SELECT})`;

const JsonObjectSchema = z.record(z.string(), z.unknown());
const PaymentMethodSchema = z.enum(['cod', 'bank_transfer', 'other']);
const AttributionTextSchema = z.string().trim().min(1).max(512);

export const GetProductToolSchema = z.object({
  orgId: z.string().uuid(),
  productId: z.string().uuid(),
});

export const CreateDraftOrderToolSchema = z.object({
  orgId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  paymentMethod: PaymentMethodSchema.default('cod'),
  customerName: z.string().trim().min(1).max(256).nullable().optional(),
  phoneE164: z.string().trim().min(1).max(32).nullable().optional(),
  addressText: z.string().trim().min(1).max(2_000).nullable().optional(),
  addressJson: JsonObjectSchema.default({}),
  idempotencyKey: z.string().trim().min(1).max(128).nullable().optional(),
  utmSource: AttributionTextSchema.nullable().optional(),
  utmMedium: AttributionTextSchema.nullable().optional(),
  utmCampaign: AttributionTextSchema.nullable().optional(),
  clickId: AttributionTextSchema.nullable().optional(),
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        qty: z.number().int().min(1).max(999),
      }),
    )
    .min(1)
    .max(50),
});

export type GetProductToolInput = z.output<typeof GetProductToolSchema>;
export type CreateDraftOrderToolInput = z.output<
  typeof CreateDraftOrderToolSchema
>;

type SupabaseError = {
  code?: string;
  message?: string;
};

type JsonObject = Record<string, unknown>;

type ProductRow = {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: string;
  attrs_json: JsonObject;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  variants?: VariantRow[] | null;
};

type VariantRow = {
  id: string;
  org_id: string;
  product_id: string;
  sku: string;
  title: string;
  price_vnd: number | string;
  stock_qty: number;
  attrs_json: JsonObject;
  created_at: string;
  updated_at: string;
};

type OrganizationSettingsRow = {
  id: string;
  settings_json: JsonObject;
};

type VariantSnapshot = {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  qty: number;
  unitPriceVnd: bigint;
  lineTotalVnd: bigint;
};

type DraftOrderRpcResponse = {
  order: unknown;
  items: unknown[];
};

@Injectable()
export class AiToolsService {
  private readonly supabase: SupabaseLike;

  constructor(
    @Optional()
    @Inject(AI_TOOLS_SUPABASE)
    supabase?: SupabaseLike,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
  }

  async getProduct(input: GetProductToolInput) {
    const { data, error } = await this.supabase
      .from('products')
      .select(PRODUCT_WITH_VARIANTS_SELECT)
      .eq('id', input.productId)
      .eq('org_id', input.orgId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throwAiToolsError(error, 'Could not get product');
    }
    if (!data) {
      throwProductNotFound();
    }

    return { product: mapProduct(data as unknown as ProductRow) };
  }

  async createDraftOrder(input: CreateDraftOrderToolInput) {
    const settings = await this.getOrgSettings(input.orgId);
    const draftMaxAmount = draftMaxAmountForOrg(settings.settings_json);
    const items = await this.resolveOrderItems(input.orgId, input.items);
    const subtotal = sumLineTotals(items);

    if (subtotal > draftMaxAmount) {
      throw new BadRequestException({
        code: 'ai_draft_amount_exceeded',
        message: 'Draft order total exceeds the AI draft maximum',
        totalVnd: subtotal.toString(),
        maxVnd: draftMaxAmount.toString(),
      });
    }

    await this.verifyOptionalOwner(
      'conversations',
      input.orgId,
      input.conversationId,
    );
    await this.verifyOptionalOwner('contacts', input.orgId, input.contactId);

    const { data, error } = await this.supabase.rpc('create_draft_order', {
      p_org_id: input.orgId,
      p_conversation_id: input.conversationId ?? null,
      p_contact_id: input.contactId ?? null,
      p_payment_method: input.paymentMethod,
      p_customer_name: input.customerName ?? null,
      p_phone_e164: input.phoneE164 ?? null,
      p_address_text: input.addressText ?? null,
      p_address_json: input.addressJson,
      p_idempotency_key: input.idempotencyKey ?? null,
      p_utm_source: input.utmSource ?? null,
      p_utm_medium: input.utmMedium ?? null,
      p_utm_campaign: input.utmCampaign ?? null,
      p_click_id: input.clickId ?? null,
      p_items: items.map((item) => ({
        product_id: item.productId,
        variant_id: item.variantId,
        title_snapshot: item.title,
        sku_snapshot: item.sku,
        qty: item.qty,
        unit_price_vnd: item.unitPriceVnd.toString(),
        line_total_vnd: item.lineTotalVnd.toString(),
      })),
    });

    if (error) {
      throwAiToolsError(error, 'Could not create draft order');
    }

    return data as DraftOrderRpcResponse;
  }

  private async getOrgSettings(orgId: string) {
    const { data, error } = await this.supabase
      .from('organizations')
      .select('id, settings_json')
      .eq('id', orgId)
      .maybeSingle();

    if (error) {
      throwAiToolsError(error, 'Could not read organization settings');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'organization_not_found',
        message: 'Organization was not found',
      });
    }

    return data as OrganizationSettingsRow;
  }

  private async resolveOrderItems(
    orgId: string,
    items: CreateDraftOrderToolInput['items'],
  ) {
    const snapshots: VariantSnapshot[] = [];
    const verifiedProducts = new Set<string>();

    for (const item of items) {
      const variant = await this.getVariant(orgId, item.variantId);

      if (!verifiedProducts.has(variant.product_id)) {
        await this.verifyActiveProduct(orgId, variant.product_id);
        verifiedProducts.add(variant.product_id);
      }

      const unitPriceVnd = toBigintVnd(variant.price_vnd);
      snapshots.push({
        productId: variant.product_id,
        variantId: variant.id,
        sku: variant.sku,
        title: variant.title,
        qty: item.qty,
        unitPriceVnd,
        lineTotalVnd: unitPriceVnd * BigInt(item.qty),
      });
    }

    return snapshots;
  }

  private async getVariant(orgId: string, variantId: string) {
    const { data, error } = await this.supabase
      .from('product_variants')
      .select(VARIANT_SELECT)
      .eq('id', variantId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      throwAiToolsError(error, 'Could not read product variant');
    }
    if (!data) {
      throw new NotFoundException({
        code: 'product_variant_not_found',
        message: 'Product variant was not found',
      });
    }

    return data as VariantRow;
  }

  private async verifyActiveProduct(orgId: string, productId: string) {
    const { data, error } = await this.supabase
      .from('products')
      .select('id')
      .eq('id', productId)
      .eq('org_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throwAiToolsError(error, 'Could not verify product');
    }
    if (!data) {
      throwProductNotFound();
    }
  }

  private async verifyOptionalOwner(
    table: 'contacts' | 'conversations',
    orgId: string,
    id: string | null | undefined,
  ) {
    if (!id) {
      return;
    }

    const { data, error } = await this.supabase
      .from(table)
      .select('id')
      .eq('id', id)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      throwAiToolsError(error, `Could not verify ${table} ownership`);
    }
    if (!data) {
      throw new NotFoundException({
        code: `${table.slice(0, -1)}_not_found`,
        message: `${table.slice(0, -1)} was not found`,
      });
    }
  }
}

export function parseGetProductToolBody(body: unknown) {
  return parseBody(GetProductToolSchema, body);
}

export function parseCreateDraftOrderToolBody(body: unknown) {
  return parseBody(CreateDraftOrderToolSchema, body);
}

function parseBody<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  body: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      message: 'Request body is invalid',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function mapProduct(row: ProductRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    attrs: row.attrs_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    variants: (row.variants ?? []).map((variant) => ({
      id: variant.id,
      productId: variant.product_id,
      sku: variant.sku,
      title: variant.title,
      priceVnd: variant.price_vnd.toString(),
      stockQty: variant.stock_qty,
      attrs: variant.attrs_json,
      createdAt: variant.created_at,
      updatedAt: variant.updated_at,
    })),
  };
}

function draftMaxAmountForOrg(settings: JsonObject) {
  const override = settings.aiDraftMaxAmountVnd;
  if (override !== undefined && override !== null) {
    return parseMaxAmount(override, 'organization aiDraftMaxAmountVnd');
  }

  return parseMaxAmount(
    process.env.DEFAULT_AI_DRAFT_MAX_AMOUNT_VND ??
      DEFAULT_AI_DRAFT_MAX_AMOUNT_VND,
    'DEFAULT_AI_DRAFT_MAX_AMOUNT_VND',
  );
}

function parseMaxAmount(value: unknown, source: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }

  throw new InternalServerErrorException({
    code: 'invalid_ai_draft_max_config',
    message: `${source} must be a non-negative integer VND amount`,
  });
}

function sumLineTotals(items: VariantSnapshot[]) {
  return items.reduce((total, item) => total + item.lineTotalVnd, 0n);
}

function toBigintVnd(value: string | number) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InternalServerErrorException({
        code: 'invalid_catalog_price',
        message: 'Catalog price must be a non-negative integer VND amount',
      });
    }
    return BigInt(value);
  }

  if (!/^\d+$/.test(value)) {
    throw new InternalServerErrorException({
      code: 'invalid_catalog_price',
      message: 'Catalog price must be a non-negative integer VND amount',
    });
  }
  return BigInt(value);
}

function throwProductNotFound(): never {
  throw new NotFoundException({
    code: 'product_not_found',
    message: 'Product was not found',
  });
}

function throwAiToolsError(error: SupabaseError, message: string): never {
  if (error.code === '23505') {
    throw new BadRequestException({
      code: 'ai_tool_conflict',
      message: error.message ?? message,
    });
  }

  throw new InternalServerErrorException({
    code: 'ai_tool_failed',
    message,
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
