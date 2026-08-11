'use client';

import type { CSSProperties, ReactNode } from 'react';

import { colorBackgroundCard, colorBorder, radiusMd, spaceLg } from './tokens';

export type CardProps = {
  children: ReactNode;
  title?: ReactNode;
  style?: CSSProperties;
};

// Matches the `panelStyle`/`cardStyle` repeated identically across
// dashboard/orders/inbox/suppliers/settings-billing (white background,
// bordered, rounded, padded).
const cardStyle: CSSProperties = {
  background: colorBackgroundCard,
  border: `1px solid ${colorBorder}`,
  borderRadius: radiusMd,
  padding: spaceLg,
};

// Matches `sectionTitleStyle` repeated identically across
// dashboard/suppliers/settings/settings-billing.
const titleStyle: CSSProperties = {
  fontSize: 22,
  margin: '0 0 16px',
};

/**
 * Shared card/section container, replacing the `panelStyle`/`sectionStyle`
 * boxes repeated across nearly every page. `style` allows one-off overrides
 * (e.g. `minHeight`, `marginTop`) the same way callers already spread extra
 * properties onto the old inline consts.
 */
export function Card({ children, title, style }: CardProps) {
  return (
    <section style={{ ...cardStyle, ...style }}>
      {title ? <h2 style={titleStyle}>{title}</h2> : null}
      {children}
    </section>
  );
}
