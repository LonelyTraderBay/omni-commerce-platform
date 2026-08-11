'use client';

import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties } from 'react';

import { colorBorderStrong, colorTextBody, radiusSm } from './tokens';

export type TextareaProps = ComponentPropsWithoutRef<'textarea'>;

// Matches `inbox/page.tsx`'s `composeInputStyle` and `auth-form.tsx`'s
// textarea override (`{ ...inputStyle, resize: 'vertical' }`).
const textareaStyle: CSSProperties = {
  border: `1px solid ${colorBorderStrong}`,
  borderRadius: radiusSm,
  color: colorTextBody,
  font: 'inherit',
  padding: '11px 12px',
  resize: 'vertical',
};

/**
 * Thin, fully-controlled wrapper around `<textarea>`. Forwards all native
 * props (`value`, `onChange`, `placeholder`, `rows`, `required`, etc.)
 * untouched so it is a drop-in replacement for a native textarea.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ style, ...props }, ref) {
    return <textarea ref={ref} style={{ ...textareaStyle, ...style }} {...props} />;
  },
);
