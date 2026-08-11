'use client';

import type { ComponentPropsWithoutRef, CSSProperties } from 'react';

import { colorBorder, colorBorderSubtle, colorTextBody, colorTextHeading } from './tokens';

// Matches the bare `<table>` styling repeated across orders/catalog/cod/ads/
// pnl/settings-channels (`borderCollapse: 'collapse', width: '100%'`, plus an
// optional page-specific `minWidth` passed through `style`).
const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
};

/**
 * Table root. Includes the `overflowX: 'auto'` wrapper div already repeated
 * around every table in this codebase (see `settings/channels/page.tsx` and
 * `orders/page.tsx`) so callers never have to remember to add it.
 */
export function Table({ style, children, ...props }: ComponentPropsWithoutRef<'table'>) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ ...tableStyle, ...style }} {...props}>
        {children}
      </table>
    </div>
  );
}

export function TableHead({ children, ...props }: ComponentPropsWithoutRef<'thead'>) {
  return <thead {...props}>{children}</thead>;
}

export function TableRow({ children, ...props }: ComponentPropsWithoutRef<'tr'>) {
  return <tr {...props}>{children}</tr>;
}

// Matches the `tableHeaderStyle` repeated byte-for-byte identically in
// orders/catalog/cod/ads/pnl/settings-channels.
const tableHeaderStyle: CSSProperties = {
  borderBottom: `1px solid ${colorBorder}`,
  color: colorTextHeading,
  fontSize: 14,
  fontWeight: 700,
  padding: '12px 16px',
  textAlign: 'left',
};

export function TableHeaderCell({
  style,
  children,
  ...props
}: ComponentPropsWithoutRef<'th'>) {
  return (
    <th style={{ ...tableHeaderStyle, ...style }} {...props}>
      {children}
    </th>
  );
}

// Matches the `tableCellStyle` repeated byte-for-byte identically in
// orders/catalog/cod/ads/pnl/settings-channels.
const tableCellStyle: CSSProperties = {
  borderBottom: `1px solid ${colorBorderSubtle}`,
  color: colorTextBody,
  fontSize: 15,
  padding: '12px 16px',
  verticalAlign: 'top',
};

export function TableCell({ style, children, ...props }: ComponentPropsWithoutRef<'td'>) {
  return (
    <td style={{ ...tableCellStyle, ...style }} {...props}>
      {children}
    </td>
  );
}
