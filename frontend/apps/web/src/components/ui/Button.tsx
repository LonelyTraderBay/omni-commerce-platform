'use client';

import type { ComponentPropsWithoutRef, CSSProperties } from 'react';

import {
  colorBackgroundCard,
  colorBorderStrong,
  colorDanger,
  colorPrimary,
  colorPrimaryText,
  colorSuccess,
  colorTextBody,
  radiusSm,
} from './tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'link';

export type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: ButtonVariant;
};

// Solid, filled button. Matches the `primaryButtonStyle` repeated
// identically in catalog/inbox/settings (radius 10 in the source; converged
// to the shared `radiusSm` token per the "one canonical value" instruction).
const primaryStyle: CSSProperties = {
  background: colorPrimary,
  border: 'none',
  borderRadius: radiusSm,
  color: colorPrimaryText,
  cursor: 'pointer',
  fontSize: 15,
  fontWeight: 800,
  padding: '11px 16px',
};

// Outlined, white button. Matches the `secondaryButtonStyle` repeated
// byte-for-byte identically in dashboard/orders/inbox (the "Tải lại" reload
// button).
const secondaryStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: radiusSm,
  color: colorTextBody,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 700,
  padding: '9px 12px',
};

// Text-only, no background. Matches `orders/page.tsx`'s action-row
// `linkButtonStyle`, which is reused for Huỷ (danger), Hoàn tất (success),
// Hoàn hàng (warning) and plain confirm (primary/link) by swapping only
// `color` — so danger/success/link all share this same shape.
//
// NOTE: `font: 'inherit'` must stay ordered *before* `fontWeight` below —
// the `font` shorthand resets weight/size/family, so declaring the longhand
// `fontWeight` afterwards is what makes the bold weight win. This mirrors
// the key order already used in `orders/page.tsx`'s `linkButtonStyle`.
const linkBaseStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 800,
  padding: 0,
};

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: primaryStyle,
  secondary: secondaryStyle,
  danger: { ...linkBaseStyle, color: colorDanger },
  success: { ...linkBaseStyle, color: colorSuccess },
  link: { ...linkBaseStyle, color: colorPrimary },
};

/**
 * Shared button primitive. Defaults to `type="button"` (not the native
 * `"submit"` default) so it never accidentally submits a surrounding form —
 * pass `type="submit"` explicitly for submit buttons, same as every existing
 * page already does.
 *
 * `disabled` automatically gets reduced opacity + `cursor: not-allowed`,
 * matching the pattern `inbox/page.tsx` already applies by hand on its
 * primary buttons (opacity 0.7).
 */
export function Button({
  variant = 'primary',
  type = 'button',
  disabled,
  style,
  ...props
}: ButtonProps) {
  const disabledStyle: CSSProperties | undefined = disabled
    ? { cursor: 'not-allowed', opacity: 0.7 }
    : undefined;

  return (
    <button
      type={type}
      disabled={disabled}
      style={{ ...variantStyles[variant], ...disabledStyle, ...style }}
      {...props}
    />
  );
}
