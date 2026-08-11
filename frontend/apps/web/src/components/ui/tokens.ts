/**
 * Design tokens for the shared `components/ui` primitives.
 *
 * These values codify "Palette A" (blue/slate), the color scheme already used
 * by the majority of pages (dashboard, orders, inbox, catalog, cod, calendar,
 * ads, attribution, pnl, advisor) and by the login/signup screen
 * (`components/auth-form.tsx`), which is also where the brand color itself
 * (`#2563eb`) is set on the "Omni Commerce" label. A second, inconsistent
 * "Palette B" (teal/zinc, e.g. `#0f766e`) drifted into a handful of newer
 * pages (suppliers, einvoice, purchase-orders, settings/invites, warehouses,
 * inventory, `m`) — that drift is what this design system exists to
 * eliminate going forward, so every value below is taken from Palette A.
 *
 * Every value here was verified against real page code (not assumed) by
 * grepping the repeated `panelStyle` / `tableHeaderStyle` / `tableCellStyle` /
 * `primaryButtonStyle` / `secondaryButtonStyle` / `inputStyle` / `alertStyle` /
 * `successStyle` constants across `dashboard/page.tsx`, `orders/page.tsx`,
 * `inbox/page.tsx`, `catalog/page.tsx`, `cod/page.tsx`, `ads/page.tsx`,
 * `pnl/page.tsx`, `settings/page.tsx` and `auth-form.tsx`. Plain flat
 * constants are used (not a theme object) to slot directly into this
 * codebase's existing inline `CSSProperties` pattern.
 */

// ---- Color: brand / actions ----------------------------------------------

/** Primary brand blue. Confirmed as the dominant `background`/`color` value
 * for primary buttons and links across every Palette-A page, and is the
 * exact color of the "Omni Commerce" wordmark in `auth-form.tsx`. */
export const colorPrimary = '#2563eb';

/** Text color used on top of `colorPrimary` (solid button labels). */
export const colorPrimaryText = '#ffffff';

/** Danger red. Confirmed via `alertStyle` (role="alert" text) repeated
 * identically in dashboard/orders/inbox/settings, and the "Huỷ" (cancel)
 * row-action color in `orders/page.tsx`. */
export const colorDanger = '#b91c1c';

/** Success green. Confirmed via `successStyle` repeated identically in
 * orders/inbox/settings, and the "Hoàn tất" (mark done) row-action color in
 * `orders/page.tsx`. */
export const colorSuccess = '#15803d';

/** Warning amber. Confirmed as the "Hoàn hàng" (return) row-action color in
 * `orders/page.tsx`'s action row — the same "700-weight" family as
 * `colorDanger`/`colorSuccess` above (this trio is literally rendered by the
 * same `linkButtonStyle` base with only `color` swapped, see
 * `orders/page.tsx` lines ~303-347). Note: a darker amber (`#92400e`) shows up
 * more often as *body text inside a tinted warning banner*
 * (`calendar`, `advisor`, `settings/billing`'s past-due notice) — that is a
 * distinct, higher-contrast-on-tint use case and was deliberately not
 * folded into this token. */
export const colorWarning = '#b45309';

// ---- Color: text -----------------------------------------------------------

/** Muted secondary text (timestamps, hints, "loading..." states). Confirmed
 * as the single most repeated text color in the audit. */
export const colorTextMuted = '#64748b';

/** Default body/data text color. Matches the `<body>` text color set in
 * `app/layout.tsx`, so most elements inherit it without repeating it. */
export const colorTextBody = '#0f172a';

/** Heading / label / table-header text color. */
export const colorTextHeading = '#334155';

// ---- Color: surfaces & borders --------------------------------------------

/** Default border for cards, panels, and table header rules. */
export const colorBorder = '#e2e8f0';

/** Stronger border for interactive controls (inputs, secondary buttons). */
export const colorBorderStrong = '#cbd5e1';

/** Faint border used exclusively for table body-cell dividers and dense
 * list rows (e.g. Settings' ToggleRow) — confirmed identical across
 * `orders`, `catalog`, `cod`, `ads`, `pnl`, and `settings/page.tsx`'s
 * `toggleRowStyle`. Not in the task's minimum list but recurs so
 * consistently it earns its own token rather than a repeated literal. */
export const colorBorderSubtle = '#f1f5f9';

/** Page background / subtle tinted surface (empty states, secondary tiles).
 * Matches the `<body>` background in `app/layout.tsx`. */
export const colorBackgroundSubtle = '#f8fafc';

/** Card / panel background, sitting on top of `colorBackgroundSubtle`. */
export const colorBackgroundCard = '#ffffff';

// ---- Radius ----------------------------------------------------------------
//
// This repo uses 8/10/12/14/16 somewhat contextually. Rather than force
// every occurrence to one number, these three tokens capture the handful of
// real recurring roles seen repeatedly across pages.

/** Buttons and form inputs. `dashboard`/`orders`/`inbox` share an identical
 * `secondaryButtonStyle` at 8; inputs and the "large" primary button style
 * (`catalog`/`inbox`/`settings`) use 10 about as often — both are folded
 * into this single canonical value per-role, per the "resolve near-duplicates
 * to one canonical value" instruction. 8 was picked because it is also the
 * single most common literal radius for buttons repo-wide. */
export const radiusSm = 8;

/** Cards, panels, and section containers. `dashboard`/`orders`/`inbox`/
 * `suppliers`/`einvoice`/`purchase-orders`/`settings` all share an identical
 * `panelStyle` at 14 — by far the majority value (empty-state boxes use 12,
 * which is close enough to fold into this same role). */
export const radiusMd = 14;

/** The largest containers, e.g. the login/signup card in `auth-form.tsx`. */
export const radiusLg = 16;

// ---- Spacing ----------------------------------------------------------------
//
// A small scale for the generic gaps/paddings repeated across layouts
// (component-internal paddings like button/input padding stay hardcoded in
// those components, since they're asymmetric per-role values, not generic
// spacing).

export const spaceXs = 8;
export const spaceSm = 12;
export const spaceMd = 16;
/** Confirmed as the dominant `panelStyle`/`cardStyle` padding (5-way exact
 * match across dashboard/orders/inbox/suppliers/settings-billing). */
export const spaceLg = 20;
export const spaceXl = 24;
