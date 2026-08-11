-- Claim-then-call for shipment creation: close the true-concurrency gap left
-- by the soft existence guard added in 20260727100000_shipping_carrier.sql /
-- ShippingService.findLiveShipment.
--
-- findLiveShipment SELECTs for a live shipment and throws before the carrier
-- is ever called -- but it is a SELECT-then-call guard: `shipments` only ever
-- gained a row AFTER provider.createShipment(...) had already booked a real
-- GHN waybill (see insertShipment in shipping.service.ts, historically called
-- only once the provider had already responded). Two truly simultaneous
-- requests for the same order both pass the SELECT (neither sees the other
-- yet) and BOTH call the real carrier. A bare unique index on `shipments`
-- cannot fix this by itself: indexes only arbitrate INSERTs, and by the time
-- either INSERT would happen, both provider calls have already fired. That
-- would only demote the failure from "2 waybills, 2 local rows" to "2
-- waybills, but the losing request's local insert 23505s" -- a real carrier
-- booking with ZERO local record, which is worse, not better.
--
-- The actual fix (in shipping.service.ts) is claim-then-call: reserve the
-- order with a `pending` row BEFORE touching the provider, so a losing
-- concurrent request fails at the INSERT, before it ever reaches
-- provider.createShipment. This migration supplies the two pieces of schema
-- that make that safe:
--   1. widen the status vocabulary to include `pending` (a service-internal
--      claim state; no provider ever returns it -- see ShipmentStatus in
--      shipping-provider.ts, which types only a provider's post-booking
--      result and is intentionally left untouched).
--   2. a partial unique index that is the actual concurrency guard.
--
-- Shape mirrors einvoice_jobs_one_active_per_order_idx
-- (20260729010000_einvoice_jobs_one_active_per_order.sql) -- same reasoning,
-- same "claim before you call the external side effect" pattern -- but for a
-- carrier booking instead of a legal invoice, plus a claim TTL/reclaim path
-- (see reclaimStaleShipmentClaim in shipping.service.ts) since a shipment
-- claim can be abandoned by a crashed process the same way an idempotency key
-- can (see reclaimExpiredIdempotencyKey in orders.service.ts).

-- Postgres cannot ALTER a CHECK constraint in place: drop and recreate it.
alter table public.shipments
  drop constraint if exists shipments_status_check;

alter table public.shipments
  add constraint shipments_status_check check (
    status in (
      'pending',
      'created',
      'picking',
      'delivering',
      'delivered',
      'cancelled',
      'failed'
    )
  );

-- One live claim-or-booking per order at a time.
--
-- `pending` participates because a claim in flight must block a concurrent
-- claim exactly as hard as an already-booked shipment does -- that is the
-- entire point: without it, two concurrent requests could both insert a
-- `pending` row and both proceed to call the carrier, reopening the exact
-- race this migration exists to close.
--
-- `cancelled` and `failed` are excluded so a cancelled or failed attempt
-- stays retryable, mirroring LIVE_SHIPMENT_STATUSES in shipping.service.ts --
-- a provider failure (or an operator cancelling a booking) must not
-- permanently strand an order out of ever being shipped.
--
-- Mock rows are excluded so mock bookings keep succeeding unboundedly, same
-- as before this change (existing behaviour, existing tests). The exclusion
-- mirrors isMockShipmentRow exactly: `raw_json ->> 'mode'` is only ever
-- 'mock' for a finalized mock result (GhnShippingProvider). A freshly
-- inserted claim row carries raw_json = '{}' (mode absent, i.e. NULL),
-- which the coalesce() turns into '' -- not 'mock' -- so a pending claim
-- correctly PARTICIPATES in the index (it must, to block concurrent
-- claimants) while it is pending or finalized as a real booking. The moment
-- a claim is finalized as a mock result, the very same UPDATE that writes
-- `raw_json.mode = 'mock'` also takes the row OUT of the index, in the same
-- statement that took it out of the "live" vocabulary conceptually -- so a
-- second mock booking for the same order is never blocked.
create unique index if not exists shipments_one_live_claim_per_order_idx
  on public.shipments (org_id, order_id)
  where status in ('pending', 'created', 'picking', 'delivering', 'delivered')
    and coalesce(raw_json ->> 'mode', '') <> 'mock';
