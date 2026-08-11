'use client';

import { type CSSProperties, useEffect, useMemo, useState } from 'react';

import {
  ApiClientError,
  getProduct,
  listProducts,
  type CatalogProduct,
} from '../lib/api-client';
import {
  Button,
  colorBackgroundCard,
  colorBorder,
  colorBorderStrong,
  colorBorderSubtle,
  colorTextMuted,
  ErrorText,
  Input,
  MutedText,
} from './ui';

export type VariantPickerProps = {
  /** Selected variant id (uuid), or '' when nothing is selected yet. */
  value: string;
  onChange: (variantId: string) => void;
  placeholder?: string;
};

type FlatVariant = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  stockQty: number;
};

/**
 * Searchable replacement for a raw "paste the variant uuid" text input.
 *
 * `GET /v1/catalog/products` (listProducts) does not include each product's
 * variants — only `GET /v1/catalog/products/:id` (getProduct) does (see
 * backend/apps/api/src/modules/catalog/catalog.service.ts: listProducts selects
 * PRODUCT_SELECT with no variants join, while getProduct selects
 * PRODUCT_WITH_VARIANTS_SELECT). So building a full searchable index means
 * listing products first, then fetching each product's detail to flatten out
 * its variants — the same two-step pattern the /catalog page already uses.
 */
export function VariantPicker({ value, onChange, placeholder }: VariantPickerProps) {
  const [catalog, setCatalog] = useState<FlatVariant[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const products = await listProducts();
        const detailed = await Promise.all(
          products.map((product) => getProduct(product.id)),
        );
        if (!cancelled) {
          setCatalog(flattenProducts(detailed));
        }
      } catch (err) {
        if (!cancelled) {
          setCatalogError(
            err instanceof ApiClientError
              ? err.message
              : 'Không thể tải danh mục sản phẩm.',
          );
        }
      } finally {
        if (!cancelled) {
          setCatalogLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever `value` changes — whether from our own onChange or from a page
  // setting it externally (e.g. inventory's "Chọn để điều chỉnh" shortcut) —
  // drop back into the resolved-label view instead of leaving a stale search
  // list open.
  useEffect(() => {
    setEditing(false);
    setQuery('');
  }, [value]);

  const selected = useMemo(
    () => catalog.find((variant) => variant.variantId === value) ?? null,
    [catalog, value],
  );

  const trimmedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!trimmedQuery) {
      return [];
    }
    return catalog.filter(
      (variant) =>
        variant.productTitle.toLowerCase().includes(trimmedQuery) ||
        variant.variantTitle.toLowerCase().includes(trimmedQuery) ||
        variant.sku.toLowerCase().includes(trimmedQuery),
    );
  }, [catalog, trimmedQuery]);

  function handleSelect(variant: FlatVariant) {
    onChange(variant.variantId);
    setEditing(false);
    setQuery('');
  }

  const showSearch = editing || !value;

  if (!showSearch) {
    return (
      <div style={selectedRowStyle}>
        <span style={selectedLabelStyle}>
          {selected ? formatVariantLabel(selected) : value}
        </span>
        <Button variant="link" style={{ flexShrink: 0 }} onClick={() => setEditing(true)}>
          Đổi
        </Button>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <Input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder ?? 'Tìm theo tên sản phẩm hoặc SKU...'}
        style={inputOverrideStyle}
      />
      {value && editing ? (
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setQuery('');
          }}
          style={cancelLinkStyle}
        >
          Huỷ, giữ lựa chọn hiện tại
        </button>
      ) : null}
      {catalogLoading ? (
        <MutedText style={{ fontSize: 13, margin: 0 }}>
          Đang tải danh mục sản phẩm...
        </MutedText>
      ) : catalogError ? (
        <ErrorText style={{ fontSize: 13, margin: 0 }}>{catalogError}</ErrorText>
      ) : trimmedQuery ? (
        results.length === 0 ? (
          <MutedText style={{ fontSize: 13, margin: 0 }}>
            Không tìm thấy sản phẩm/SKU nào khớp.
          </MutedText>
        ) : (
          <ul style={listStyle}>
            {results.map((variant) => (
              <li key={variant.variantId}>
                <button
                  type="button"
                  onClick={() => handleSelect(variant)}
                  style={resultButtonStyle}
                >
                  <span style={{ fontWeight: 700 }}>
                    {variant.productTitle} / {variant.variantTitle}
                  </span>
                  <span style={mutedResultStyle}>
                    SKU {variant.sku} · Tồn: {variant.stockQty}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function flattenProducts(products: CatalogProduct[]): FlatVariant[] {
  const flat: FlatVariant[] = [];
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      flat.push({
        variantId: variant.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        stockQty: variant.stockQty,
      });
    }
  }
  return flat;
}

function formatVariantLabel(variant: FlatVariant): string {
  return `${variant.productTitle} / ${variant.variantTitle} · SKU ${variant.sku} · Tồn: ${variant.stockQty}`;
}

const wrapperStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
};

const inputOverrideStyle: CSSProperties = {
  boxSizing: 'border-box',
  fontSize: 15,
  width: '100%',
};

const listStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorder}`,
  borderRadius: 8,
  display: 'grid',
  gap: 4,
  listStyle: 'none',
  margin: 0,
  maxHeight: 260,
  overflowY: 'auto',
  padding: 0,
};

const resultButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 0,
  borderBottom: `1px solid ${colorBorderSubtle}`,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  font: 'inherit',
  gap: 2,
  padding: '8px 10px',
  textAlign: 'left',
  width: '100%',
};

const mutedResultStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 13,
};

const selectedRowStyle: CSSProperties = {
  alignItems: 'center',
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: 8,
  display: 'flex',
  fontSize: 15,
  gap: 10,
  padding: '10px 12px',
};

const selectedLabelStyle: CSSProperties = {
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const cancelLinkStyle: CSSProperties = {
  background: 'transparent',
  border: 0,
  color: colorTextMuted,
  cursor: 'pointer',
  fontSize: 13,
  justifySelf: 'start',
  padding: 0,
  textAlign: 'left',
};
