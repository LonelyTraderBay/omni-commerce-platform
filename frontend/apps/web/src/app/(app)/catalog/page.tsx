'use client';

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  ApiClientError,
  createProduct,
  createVariant,
  deleteProduct,
  deleteVariant,
  getProduct,
  listProducts,
  updateProduct,
  updateVariant,
  type CatalogProduct,
  type CatalogVariant,
  type ProductStatus,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorBackgroundCard,
  colorBorder,
  colorBorderStrong,
  colorDanger,
  colorPrimary,
  colorTextBody,
  colorTextHeading,
  colorTextMuted,
  EmptyState,
  ErrorText,
  Input,
  MutedText,
  SuccessText,
  Table,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textarea,
} from '../../../components/ui';

const emptyProductForm = {
  title: '',
  description: '',
  status: 'active' as ProductStatus,
};

const emptyVariantForm = {
  sku: '',
  title: '',
  priceVnd: '',
  stockQty: 0,
  cogsVnd: '',
};

export default function CatalogPage() {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(
    null,
  );
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState(emptyProductForm);
  const [variantForm, setVariantForm] = useState(emptyVariantForm);
  const [loading, setLoading] = useState(true);
  const [savingProduct, setSavingProduct] = useState(false);
  const [savingVariant, setSavingVariant] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedProductId = selectedProduct?.id ?? null;

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await listProducts();
      setProducts(data);
      if (selectedProductId) {
        const detail = await getProduct(selectedProductId);
        setSelectedProduct(detail);
      } else if (data[0]) {
        setSelectedProduct(await getProduct(data[0].id));
      } else {
        setSelectedProduct(null);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tải danh mục sản phẩm.'));
      setProducts([]);
      setSelectedProduct(null);
    } finally {
      setLoading(false);
    }
  }, [selectedProductId]);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      setSelectedProduct(null);
      setEditingVariantId(null);
      void loadProducts();
    }

    void loadProducts();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadProducts]);

  useEffect(() => {
    if (!selectedProduct) {
      setProductForm(emptyProductForm);
      return;
    }

    setProductForm({
      title: selectedProduct.title,
      description: selectedProduct.description ?? '',
      status: selectedProduct.status,
    });
  }, [selectedProduct]);

  const editingVariant = useMemo(
    () =>
      selectedProduct?.variants?.find((variant) => variant.id === editingVariantId) ??
      null,
    [editingVariantId, selectedProduct],
  );

  useEffect(() => {
    if (!editingVariant) {
      setVariantForm(emptyVariantForm);
      return;
    }

    setVariantForm({
      sku: editingVariant.sku,
      title: editingVariant.title,
      priceVnd: editingVariant.priceVnd,
      stockQty: editingVariant.stockQty,
      cogsVnd: editingVariant.cogsVnd ?? '0',
    });
  }, [editingVariant]);

  async function selectProduct(productId: string) {
    setError(null);
    setMessage(null);
    setEditingVariantId(null);

    try {
      setSelectedProduct(await getProduct(productId));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tải chi tiết sản phẩm.'));
    }
  }

  async function handleProductSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingProduct(true);
    setError(null);
    setMessage(null);

    const title = productForm.title.trim();
    if (!title) {
      setError('Vui lòng nhập tên sản phẩm.');
      setSavingProduct(false);
      return;
    }

    try {
      const payload = {
        title,
        description: productForm.description.trim() || null,
        status: productForm.status,
        attrs: {},
      };
      const product = selectedProduct
        ? await updateProduct(selectedProduct.id, payload)
        : await createProduct(payload);

      setMessage(
        selectedProduct ? 'Đã cập nhật sản phẩm.' : 'Đã tạo sản phẩm mới.',
      );
      setSelectedProduct(await getProduct(product.id));
      setProducts(await listProducts());
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể lưu sản phẩm.'));
    } finally {
      setSavingProduct(false);
    }
  }

  async function handleDeleteProduct() {
    if (!selectedProduct) {
      return;
    }

    setSavingProduct(true);
    setError(null);
    setMessage(null);

    try {
      await deleteProduct(selectedProduct.id);
      setSelectedProduct(null);
      setEditingVariantId(null);
      setProductForm(emptyProductForm);
      setProducts(await listProducts());
      setMessage('Đã xoá sản phẩm khỏi danh mục.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể xoá sản phẩm.'));
    } finally {
      setSavingProduct(false);
    }
  }

  async function handleVariantSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct) {
      setError('Hãy chọn sản phẩm trước khi lưu phiên bản.');
      return;
    }

    setSavingVariant(true);
    setError(null);
    setMessage(null);

    const sku = variantForm.sku.trim();
    const title = variantForm.title.trim();
    const priceVnd = variantForm.priceVnd.trim();
    const cogsVnd = variantForm.cogsVnd.trim();

    if (!sku || !title || !/^\d+$/.test(priceVnd) || (cogsVnd && !/^\d+$/.test(cogsVnd))) {
      setError('Vui lòng nhập SKU, tên phiên bản, giá và COGS VND hợp lệ.');
      setSavingVariant(false);
      return;
    }

    try {
      const payload = {
        sku,
        title,
        priceVnd,
        stockQty: Number(variantForm.stockQty),
        cogsVnd: cogsVnd || '0',
        attrs: {},
      };

      if (editingVariantId) {
        await updateVariant(selectedProduct.id, editingVariantId, payload);
      } else {
        await createVariant(selectedProduct.id, payload);
      }

      setSelectedProduct(await getProduct(selectedProduct.id));
      setEditingVariantId(null);
      setVariantForm(emptyVariantForm);
      setMessage(editingVariantId ? 'Đã cập nhật phiên bản.' : 'Đã thêm phiên bản.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể lưu phiên bản.'));
    } finally {
      setSavingVariant(false);
    }
  }

  async function handleDeleteVariant(variant: CatalogVariant) {
    if (!selectedProduct) {
      return;
    }

    setSavingVariant(true);
    setError(null);
    setMessage(null);

    try {
      await deleteVariant(selectedProduct.id, variant.id);
      setSelectedProduct(await getProduct(selectedProduct.id));
      if (editingVariantId === variant.id) {
        setEditingVariantId(null);
      }
      setMessage('Đã xoá phiên bản.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể xoá phiên bản.'));
    } finally {
      setSavingVariant(false);
    }
  }

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Danh mục sản phẩm</h1>
          <p style={descriptionStyle}>
            Quản lý sản phẩm, SKU, giá và tồn kho qua API /v1/catalog/products.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setSelectedProduct(null);
            setEditingVariantId(null);
            setProductForm(emptyProductForm);
          }}
        >
          Tạo sản phẩm mới
        </Button>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <div style={layoutStyle}>
        <Card>
          <div style={panelHeaderStyle}>
            <h2 style={sectionTitleStyle}>Sản phẩm</h2>
            <Button
              variant="secondary"
              onClick={() => void loadProducts()}
              disabled={loading}
            >
              {loading ? 'Đang tải...' : 'Tải lại'}
            </Button>
          </div>

          {loading ? (
            <MutedText style={{ fontSize: 14 }}>Đang tải sản phẩm...</MutedText>
          ) : products.length === 0 ? (
            <EmptyState>Chưa có sản phẩm nào.</EmptyState>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {products.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => void selectProduct(product.id)}
                  style={{
                    ...productButtonStyle,
                    borderColor:
                      product.id === selectedProduct?.id ? colorPrimary : colorBorder,
                    background:
                      product.id === selectedProduct?.id
                        ? '#eff6ff'
                        : colorBackgroundCard,
                  }}
                >
                  <span style={{ fontWeight: 800 }}>{product.title}</span>
                  <span style={mutedStyle}>
                    {formatStatus(product.status)} - cập nhật{' '}
                    {formatDateTime(product.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 style={sectionTitleStyle}>
            {selectedProduct ? 'Sửa sản phẩm' : 'Tạo sản phẩm'}
          </h2>
          <form onSubmit={(event) => void handleProductSubmit(event)}>
            <label style={labelStyle}>
              Tên sản phẩm
              <Input
                value={productForm.title}
                onChange={(event) =>
                  setProductForm((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
              />
            </label>
            <label style={labelStyle}>
              Mô tả
              <Textarea
                value={productForm.description}
                onChange={(event) =>
                  setProductForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                rows={4}
              />
            </label>
            <label style={labelStyle}>
              Trạng thái
              <select
                value={productForm.status}
                onChange={(event) =>
                  setProductForm((current) => ({
                    ...current,
                    status: event.target.value as ProductStatus,
                  }))
                }
                style={selectStyle}
              >
                <option value="active">Đang bán</option>
                <option value="archived">Lưu trữ</option>
              </select>
            </label>
            <div style={buttonRowStyle}>
              <Button type="submit" disabled={savingProduct}>
                {savingProduct ? 'Đang lưu...' : 'Lưu sản phẩm'}
              </Button>
              {selectedProduct ? (
                <Button
                  variant="secondary"
                  style={{ color: colorDanger }}
                  onClick={() => void handleDeleteProduct()}
                  disabled={savingProduct}
                >
                  Xoá
                </Button>
              ) : null}
            </div>
          </form>

          <hr style={dividerStyle} />

          <h2 style={sectionTitleStyle}>Phiên bản / SKU</h2>
          {!selectedProduct ? (
            <EmptyState>Chọn hoặc tạo sản phẩm trước khi thêm SKU.</EmptyState>
          ) : (
            <>
              <form onSubmit={(event) => void handleVariantSubmit(event)}>
                <div style={variantFormGridStyle}>
                  <label style={labelStyle}>
                    SKU
                    <Input
                      value={variantForm.sku}
                      onChange={(event) =>
                        setVariantForm((current) => ({
                          ...current,
                          sku: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label style={labelStyle}>
                    Tên phiên bản
                    <Input
                      value={variantForm.title}
                      onChange={(event) =>
                        setVariantForm((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label style={labelStyle}>
                    Giá VND
                    <Input
                      inputMode="numeric"
                      value={variantForm.priceVnd}
                      onChange={(event) =>
                        setVariantForm((current) => ({
                          ...current,
                          priceVnd: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label style={labelStyle}>
                    COGS VND / đơn vị
                    <Input
                      inputMode="numeric"
                      placeholder="0"
                      value={variantForm.cogsVnd}
                      onChange={(event) =>
                        setVariantForm((current) => ({
                          ...current,
                          cogsVnd: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label style={labelStyle}>
                    Tồn kho
                    <Input
                      min={0}
                      type="number"
                      value={variantForm.stockQty}
                      onChange={(event) =>
                        setVariantForm((current) => ({
                          ...current,
                          stockQty: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                </div>
                <div style={buttonRowStyle}>
                  <Button type="submit" disabled={savingVariant}>
                    {savingVariant
                      ? 'Đang lưu...'
                      : editingVariantId
                        ? 'Lưu SKU'
                        : 'Thêm SKU'}
                  </Button>
                  {editingVariantId ? (
                    <Button
                      variant="secondary"
                      onClick={() => setEditingVariantId(null)}
                    >
                      Huỷ sửa
                    </Button>
                  ) : null}
                </div>
              </form>

              {(selectedProduct.variants ?? []).length === 0 ? (
                <EmptyState>Sản phẩm chưa có SKU.</EmptyState>
              ) : (
                <Table style={{ marginTop: 18, minWidth: 680 }}>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell>SKU</TableHeaderCell>
                      <TableHeaderCell>Tên</TableHeaderCell>
                      <TableHeaderCell>Giá</TableHeaderCell>
                      <TableHeaderCell>COGS</TableHeaderCell>
                      <TableHeaderCell>Tồn</TableHeaderCell>
                      <TableHeaderCell>Thao tác</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <tbody>
                    {(selectedProduct.variants ?? []).map((variant) => (
                      <TableRow key={variant.id}>
                        <TableCell>{variant.sku}</TableCell>
                        <TableCell>{variant.title}</TableCell>
                        <TableCell>
                          {formatMoney(variant.priceVnd)}
                        </TableCell>
                        <TableCell>
                          {formatMoney(variant.cogsVnd ?? '0')}
                        </TableCell>
                        <TableCell>{variant.stockQty}</TableCell>
                        <TableCell>
                          <Button
                            variant="link"
                            onClick={() => setEditingVariantId(variant.id)}
                            disabled={savingVariant}
                          >
                            Sửa
                          </Button>{' '}
                          <Button
                            variant="danger"
                            onClick={() => void handleDeleteVariant(variant)}
                            disabled={savingVariant}
                          >
                            Xoá
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </>
          )}
        </Card>
      </div>
    </main>
  );
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function formatStatus(status: ProductStatus) {
  return status === 'active' ? 'Đang bán' : 'Lưu trữ';
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatMoney(value: string) {
  return new Intl.NumberFormat('vi-VN', {
    currency: 'VND',
    style: 'currency',
  }).format(Number(value));
}

const headerStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  gap: 16,
  justifyContent: 'space-between',
};

const descriptionStyle: CSSProperties = {
  color: '#475569',
  fontSize: 18,
  maxWidth: 760,
};

const layoutStyle: CSSProperties = {
  alignItems: 'start',
  display: 'grid',
  gap: 24,
  gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)',
  marginTop: 28,
};

const panelHeaderStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 12,
  justifyContent: 'space-between',
  marginBottom: 16,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 22,
  margin: '0 0 16px',
};

const productButtonStyle: CSSProperties = {
  border: `1px solid ${colorBorder}`,
  borderRadius: 12,
  color: colorTextBody,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 14,
  textAlign: 'left',
};

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14,
  fontWeight: 700,
  gap: 6,
  marginTop: 14,
};

// No shared `Select` primitive exists yet, so the native <select> keeps a
// local style, just with the border/text literals swapped for their tokens
// (radius stays a raw 10, matching the same native-<select> precedent in
// orders/page.tsx).
const selectStyle: CSSProperties = {
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: 10,
  color: colorTextBody,
  font: 'inherit',
  padding: '11px 12px',
};

const variantFormGridStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  marginTop: 18,
};

const dividerStyle: CSSProperties = {
  border: 'none',
  borderTop: `1px solid ${colorBorder}`,
  margin: '28px 0',
};

const mutedStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 14,
};
