'use client';

import type { CSSProperties, ReactNode } from 'react';

import {
  colorBackgroundSubtle,
  colorBorder,
  colorDanger,
  colorSuccess,
  colorTextMuted,
  colorWarning,
  radiusMd,
} from './tokens';

type StatusTextProps = {
  children: ReactNode;
  /** One-off override, e.g. `{ marginTop: 0 }` when the text is the first
   * element inside a `Card`. */
  style?: CSSProperties;
};

// Matches `alertStyle`, repeated identically (color/fontSize/marginTop)
// across dashboard/orders/inbox/settings/settings-channels.
const errorStyle: CSSProperties = {
  color: colorDanger,
  fontSize: 16,
  marginTop: 20,
};

/** `role="alert"` error message, replacing the repeated `alertStyle` text. */
export function ErrorText({ children, style }: StatusTextProps) {
  return (
    <p role="alert" style={{ ...errorStyle, ...style }}>
      {children}
    </p>
  );
}

// Matches `successStyle`, repeated identically across
// orders/inbox/settings/settings-channels.
const successStyle: CSSProperties = {
  color: colorSuccess,
  fontSize: 16,
  marginTop: 20,
};

/** `role="status"` success message, replacing the repeated `successStyle` text. */
export function SuccessText({ children, style }: StatusTextProps) {
  return (
    <p role="status" style={{ ...successStyle, ...style }}>
      {children}
    </p>
  );
}

// Same shape as ErrorText/SuccessText (plain colored text, no background) so
// the three read as one family — see `colorWarning` in tokens.ts for why
// `#b45309` (not the darker `#92400e` used for banner text elsewhere) is the
// right color here.
const warningStyle: CSSProperties = {
  color: colorWarning,
  fontSize: 16,
  marginTop: 20,
};

/** Plain warning message (no role — matches the source, which also had none). */
export function WarningText({ children, style }: StatusTextProps) {
  return <p style={{ ...warningStyle, ...style }}>{children}</p>;
}

// Matches `emptyStyle`/`emptyStateStyle`, repeated identically across
// dashboard/orders/inbox (radius 12 in the source, converged to the shared
// `radiusMd` token — a 2px difference from a near-duplicate value).
const emptyStateStyle: CSSProperties = {
  background: colorBackgroundSubtle,
  border: `1px solid ${colorBorder}`,
  borderRadius: radiusMd,
  color: colorTextMuted,
  padding: 16,
};

/** Muted "nothing here yet" message box. */
export function EmptyState({ children, style }: StatusTextProps) {
  return <p style={{ ...emptyStateStyle, ...style }}>{children}</p>;
}

// Matches `mutedStyle`/`mutedTextStyle`, repeated everywhere for loading
// states, hints, and secondary metadata.
const mutedTextStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 15,
};

/** Muted secondary text (loading states, hints, metadata) — not part of the
 * originally-requested trio, but added since it is repeated just as often
 * and both proof-of-concept pages need it to avoid a leftover inline
 * override. */
export function MutedText({ children, style }: StatusTextProps) {
  return <p style={{ ...mutedTextStyle, ...style }}>{children}</p>;
}
