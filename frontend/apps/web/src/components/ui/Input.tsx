'use client';

import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties } from 'react';

import { colorBorderStrong, colorTextBody, radiusSm } from './tokens';

export type InputProps = ComponentPropsWithoutRef<'input'>;

// Matches the `inputStyle` repeated identically in `orders/page.tsx` and
// `auth-form.tsx` (and near-identically, modulo `resize`, in `inbox/page.tsx`'s
// `composeInputStyle`). `font: 'inherit'` is required because native
// `<input>` elements don't inherit the body font by default.
const inputStyle: CSSProperties = {
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: radiusSm,
  color: colorTextBody,
  font: 'inherit',
  padding: '11px 12px',
};

/**
 * Thin, fully-controlled wrapper around `<input>`. Forwards all native props
 * (`value`, `onChange`, `placeholder`, `required`, `type`, etc.) untouched so
 * it is a drop-in replacement for a native input with the shared border/
 * radius/padding/font styling already repeated across every page.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { style, ...props },
  ref,
) {
  return <input ref={ref} style={{ ...inputStyle, ...style }} {...props} />;
});
