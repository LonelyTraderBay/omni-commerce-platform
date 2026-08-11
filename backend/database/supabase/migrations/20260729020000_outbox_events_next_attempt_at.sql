-- Wave P0.5c — outbox delivery resilience.
--
-- Problem: `OutboxPublisher.publishPending` retried failed events on every tick
-- (2s) with no backoff and a hard cap of 5 attempts. A ~10 second Inngest
-- outage therefore burned the entire attempt budget of every in-flight event
-- and dead-lettered all of them permanently, because the pending scan filters
-- `attempts < maxAttempts` and nothing ever lowers `attempts` again.
--
-- Fix: give each row an explicit "not before" timestamp. The publisher sets it
-- to `now() + backoff(attempts)` whenever a send fails and skips rows whose
-- `next_attempt_at` is still in the future, so a transient outage costs time
-- rather than the whole retry budget.
--
-- NULL means "eligible now" — that is the correct value for freshly enqueued
-- rows and keeps `enqueueOutbox` inserts unchanged.

alter table public.outbox_events
  add column if not exists next_attempt_at timestamptz;

comment on column public.outbox_events.next_attempt_at is
  'Exponential-backoff gate. NULL = eligible immediately. Set to now() + backoff(attempts) after a failed send; the publisher only selects rows where this is NULL or already in the past.';

-- The pending scan is: published_at is null AND attempts < max
--   AND (next_attempt_at is null OR next_attempt_at <= now())
--   ORDER BY created_at.
-- The pre-existing partial index only covered `published_at`, so every tick
-- re-read backed-off rows just to discard them in Postgres.
create index if not exists outbox_events_pending_next_attempt_idx
  on public.outbox_events (next_attempt_at, created_at)
  where published_at is null;
