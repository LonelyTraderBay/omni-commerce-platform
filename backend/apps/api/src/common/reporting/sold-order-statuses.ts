/**
 * The order statuses at which revenue is recognized.
 *
 * Every money report has to agree on this vocabulary. When it does not, the
 * same date window produces two different "revenue" numbers that can never be
 * reconciled — and that is not hypothetical: attribution used to sum
 * `orders.total_vnd` across *every* status, so `draft` orders that never
 * converted (plus `cancelled` and `returned` ones) inflated attribution revenue
 * by their full value while P&L correctly reported zero for them.
 *
 * This lives in `common/` rather than being re-declared inside each reporting
 * module precisely because the per-module copies are what let the definitions
 * drift apart in the first place. Small helpers are duplicated by convention in
 * this repo; a *shared business definition* that three reports must agree on is
 * the case where a single source of truth earns its keep.
 */
export type SoldOrderStatus = 'shipped' | 'done';

export const SOLD_ORDER_STATUSES: readonly SoldOrderStatus[] = [
  'shipped',
  'done',
];
