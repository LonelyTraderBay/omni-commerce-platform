'use client';

import type { CSSProperties, ReactNode } from 'react';

import { colorBorderSubtle, colorTextBody, colorTextMuted } from './tokens';

export type ToggleProps = {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

const rowStyle: CSSProperties = {
  alignItems: 'center',
  borderBottom: `1px solid ${colorBorderSubtle}`,
  display: 'flex',
  gap: 16,
  justifyContent: 'space-between',
  padding: '16px 0',
};

const titleStyle: CSSProperties = {
  color: colorTextBody,
  display: 'block',
  fontSize: 16,
};

const descriptionStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 15,
};

const checkboxStyle: CSSProperties = {
  height: 20,
  width: 20,
};

/**
 * Title + description + checkbox row, matching `settings/page.tsx`'s
 * `ToggleRow` exactly (that page is planned for a later conversion wave, so
 * this primitive is ready for it).
 */
export function Toggle({ title, description, checked, onChange }: ToggleProps) {
  return (
    <label style={rowStyle}>
      <span>
        <strong style={titleStyle}>{title}</strong>
        {description ? <span style={descriptionStyle}>{description}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={checkboxStyle}
      />
    </label>
  );
}
