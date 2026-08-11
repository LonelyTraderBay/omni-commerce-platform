import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadEnv } from '../../config/env';
import {
  enqueueOutbox,
  type EnqueueOutboxInput,
} from '../../jobs/outbox.publisher';
import { InventoryService } from '../inventory/inventory.service';
import type {
  CreateProductBody,
  CreateVariantBody,
  UpdateProductBody,
  UpdateVariantBody,
} from './dto';

export const CATALOG_SUPABASE = Symbol('CATALOG_SUPABASE');
export const CATALOG_OUTBOX = Symbol('CATALOG_OUTBOX');

export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;
export type OutboxEnqueuer = (
  tx: SupabaseLike,
  input: EnqueueOutboxInput,
) => Promise<unknown>;

type JsonObject = Record<string, unknown>;
type ProductStatus = 'active' | 'archived';

type ProductRow = {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: ProductStatus;
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
  cogs_vnd: number | string;
  attrs_json: JsonObject;
  created_at: string;
  updated_at: string;
};

type ProductInsert = {
  org_id: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  attrs_json: JsonObject;
};

type ProductUpdate = Partial<Omit<ProductInsert, 'org_id'>> & {
  updated_at: string;
};

type VariantInsert = {
  org_id: string;
  product_id: string;
  sku: string;
  title: string;
  price_vnd: string;
  stock_qty: number;
  cogs_vnd: string;
  attrs_json: JsonObject;
};

type VariantUpdate = Partial<Omit<VariantInsert, 'org_id' | 'product_id'>> & {
  updated_at: string;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

type CreateProductRpcRow = {
  product: ProductRow;
  variants: VariantRow[] | null;
  outbox_event_id: string;
};

const PRODUCT_SELECT =
  'id, org_id, title, description, status, attrs_json, created_at, updated_at, deleted_at';
const VARIANT_SELECT =
  'id, org_id, product_id, sku, title, price_vnd, stock_qty, cogs_vnd, attrs_json, created_at, updated_at';
const PRODUCT_WITH_VARIANTS_SELECT = `${PRODUCT_SELECT}, variants:product_variants(${VARIANT_SELECT})`;

@Injectable()
export class CatalogService {
  private readonly supabase: SupabaseLike;
  private readonly enqueue: OutboxEnqueuer;
  private readonly inventory: InventoryService;

  constructor(
    @Optional()
    @Inject(CATALOG_SUPABASE)
    supabase?: SupabaseLike,
    @Optional()
    @Inject(CATALOG_OUTBOX)
    outbox?: OutboxEnqueuer,
    @Optional() inventory?: InventoryService,
  ) {
    this.supabase = supabase ?? createSupabaseServiceClient();
    this.enqueue = outbox ?? enqueueOutbox;
    this.inventory = inventory ?? new InventoryService(this.supabase);
  }

  async listProducts(orgId: string) {
    const { data, error } = await this.supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (error) {
      throwCatalogError(error, 'Could not list products');
    }

    return {
      products: ((data ?? []) as ProductRow[]).map((row) =>
        mapProduct(row, { includeDeletedAt: false }),
      ),
    };
  }

  async getProduct(orgId: string, productId: string) {
    const product = await this.requireProduct(orgId, productId, {
      withVariants: true,
    });

    return { product: mapProduct(product, { includeVariants: true }) };
  }

  async createProduct(orgId: string, body: CreateProductBody) {
    const { data, error } = await this.supabase
      .rpc('create_product_with_variants_and_reindex', {
        p_org_id: orgId,
        p_title: body.title,
        p_description: body.description ?? null,
        p_status: body.status,
        p_attrs_json: body.attrs,
        p_variants: body.variants.map((variant) => ({
          sku: variant.sku,
          title: variant.title,
          price_vnd: variant.priceVnd,
          stock_qty: variant.stockQty,
          cogs_vnd: variant.cogsVnd,
          attrs_json: variant.attrs,
        })),
      })
      .single();

    if (error) {
      throwCatalogError(error, 'Could not create product');
    }

    const row = data as CreateProductRpcRow;

    return {
      product: mapProduct(
        {
          ...(row.product as ProductRow),
          variants: (row.variants ?? []) as VariantRow[],
        },
        { includeVariants: true },
      ),
    };
  }

  async updateProduct(
    orgId: string,
    productId: string,
    body: UpdateProductBody,
  ) {
    const patch: ProductUpdate = {
      updated_at: new Date().toISOString(),
    };

    if (body.title !== undefined) {
      patch.title = body.title;
    }
    if (body.description !== undefined) {
      patch.description = body.description;
    }
    if (body.status !== undefined) {
      patch.status = body.status;
    }
    if (body.attrs !== undefined) {
      patch.attrs_json = body.attrs;
    }

    const { data, error } = await this.supabase
      .from('products')
      .update(patch)
      .eq('id', productId)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .select(PRODUCT_SELECT)
      .maybeSingle();

    if (error) {
      throwCatalogError(error, 'Could not update product');
    }
    if (!data) {
      throwProductNotFound();
    }

    await this.enqueueProductReindex(orgId, productId);

    return { product: mapProduct(data as ProductRow) };
  }

  async deleteProduct(orgId: string, productId: string) {
    const deletedAt = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('products')
      .update({
        deleted_at: deletedAt,
        updated_at: deletedAt,
      })
      .eq('id', productId)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .select(PRODUCT_SELECT)
      .maybeSingle();

    if (error) {
      throwCatalogError(error, 'Could not delete product');
    }
    if (!data) {
      throwProductNotFound();
    }

    await this.enqueueProductReindex(orgId, productId);

    return {
      product: mapProduct(data as ProductRow, { includeDeletedAt: true }),
    };
  }

  async createVariant(
    orgId: string,
    productId: string,
    body: CreateVariantBody,
  ) {
    await this.requireProduct(orgId, productId);
    const [variant] = await this.insertVariants(orgId, productId, [body]);

    await this.enqueueProductReindex(orgId, productId);

    return { variant: mapVariant(variant) };
  }

  async updateVariant(
    orgId: string,
    productId: string,
    variantId: string,
    body: UpdateVariantBody,
  ) {
    await this.requireProduct(orgId, productId);
    const patch: VariantUpdate = {
      updated_at: new Date().toISOString(),
    };

    if (body.sku !== undefined) {
      patch.sku = body.sku;
    }
    if (body.title !== undefined) {
      patch.title = body.title;
    }
    if (body.priceVnd !== undefined) {
      patch.price_vnd = body.priceVnd;
    }
    if (body.cogsVnd !== undefined) {
      patch.cogs_vnd = body.cogsVnd;
    }
    if (body.attrs !== undefined) {
      patch.attrs_json = body.attrs;
    }

    if (body.stockQty !== undefined) {
      await this.inventory.setStockQty({
        orgId,
        variantId,
        targetQty: body.stockQty,
        reason: 'catalog stockQty update',
      });
    }

    const hasNonStockPatch =
      body.sku !== undefined ||
      body.title !== undefined ||
      body.priceVnd !== undefined ||
      body.cogsVnd !== undefined ||
      body.attrs !== undefined;

    if (!hasNonStockPatch) {
      const { data, error } = await this.supabase
        .from('product_variants')
        .select(VARIANT_SELECT)
        .eq('id', variantId)
        .eq('org_id', orgId)
        .eq('product_id', productId)
        .maybeSingle();

      if (error) {
        throwCatalogError(error, 'Could not read product variant');
      }
      if (!data) {
        throwVariantNotFound();
      }

      await this.enqueueProductReindex(orgId, productId);
      return { variant: mapVariant(data as VariantRow) };
    }

    const { data, error } = await this.supabase
      .from('product_variants')
      .update(patch)
      .eq('id', variantId)
      .eq('org_id', orgId)
      .eq('product_id', productId)
      .select(VARIANT_SELECT)
      .maybeSingle();

    if (error) {
      throwCatalogError(error, 'Could not update product variant');
    }
    if (!data) {
      throwVariantNotFound();
    }

    await this.enqueueProductReindex(orgId, productId);

    return { variant: mapVariant(data as VariantRow) };
  }

  async deleteVariant(orgId: string, productId: string, variantId: string) {
    await this.requireProduct(orgId, productId);
    const { data, error } = await this.supabase
      .from('product_variants')
      .delete()
      .eq('id', variantId)
      .eq('org_id', orgId)
      .eq('product_id', productId)
      .select(VARIANT_SELECT)
      .maybeSingle();

    if (error) {
      throwCatalogError(error, 'Could not delete product variant');
    }
    if (!data) {
      throwVariantNotFound();
    }

    await this.enqueueProductReindex(orgId, productId);

    return { variant: mapVariant(data as VariantRow) };
  }

  private async insertVariants(
    orgId: string,
    productId: string,
    variants: CreateVariantBody[],
  ) {
    const rows = variants.map(
      (variant) =>
        ({
          org_id: orgId,
          product_id: productId,
          sku: variant.sku,
          title: variant.title,
          price_vnd: variant.priceVnd,
          stock_qty: variant.stockQty,
          cogs_vnd: variant.cogsVnd,
          attrs_json: variant.attrs,
        }) satisfies VariantInsert,
    );

    const { data, error } = await this.supabase
      .from('product_variants')
      .insert(rows)
      .select(VARIANT_SELECT);

    if (error) {
      throwCatalogError(error, 'Could not create product variants');
    }

    return (data ?? []) as VariantRow[];
  }

  private async requireProduct(
    orgId: string,
    productId: string,
    options: { withVariants?: boolean } = {},
  ) {
    const { data, error } = await this.supabase
      .from('products')
      .select(
        options.withVariants ? PRODUCT_WITH_VARIANTS_SELECT : PRODUCT_SELECT,
      )
      .eq('id', productId)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throwCatalogError(error, 'Could not find product');
    }
    if (!data) {
      throwProductNotFound();
    }

    return data as unknown as ProductRow;
  }

  private async enqueueProductReindex(orgId: string, productId: string) {
    await this.enqueue(this.supabase, {
      orgId,
      eventName: 'knowledge.reindex',
      payload: {
        orgId,
        sourceType: 'product',
        sourceId: productId,
      },
    });
  }
}

function mapProduct(
  row: ProductRow,
  options: { includeDeletedAt?: boolean; includeVariants?: boolean } = {},
) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    attrs: row.attrs_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(options.includeDeletedAt ? { deletedAt: row.deleted_at } : {}),
    ...(options.includeVariants
      ? { variants: (row.variants ?? []).map(mapVariant) }
      : {}),
  };
}

function mapVariant(row: VariantRow) {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    title: row.title,
    priceVnd: row.price_vnd.toString(),
    stockQty: row.stock_qty,
    cogsVnd: row.cogs_vnd?.toString() ?? '0',
    attrs: row.attrs_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function throwProductNotFound(): never {
  throw new NotFoundException({
    code: 'product_not_found',
    message: 'Product was not found',
  });
}

function throwVariantNotFound(): never {
  throw new NotFoundException({
    code: 'product_variant_not_found',
    message: 'Product variant was not found',
  });
}

function throwCatalogError(error: SupabaseError, message: string): never {
  if (error.code === '23505') {
    throw new BadRequestException({
      code: 'catalog_conflict',
      message: error.message ?? message,
    });
  }

  throw new InternalServerErrorException({
    code: 'catalog_failed',
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
