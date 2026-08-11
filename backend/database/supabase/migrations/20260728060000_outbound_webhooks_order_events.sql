-- Outbound webhooks can now actually fire for order.confirmed / order.shipped /
-- order.done (orders.service.ts enqueues these via the outbox on real lifecycle
-- transitions), but outbound_webhooks_events_check still only allowed
-- order.created / order.updated / order.cancelled / order.returned / webhook.test
-- (see 20260727180000_content_calendar_public_api.sql lines 58-59). Widen the
-- allow-list so merchants can subscribe to the three previously-missing events.
alter table public.outbound_webhooks
  drop constraint if exists outbound_webhooks_events_check;

alter table public.outbound_webhooks
  add constraint outbound_webhooks_events_check
  check (events <@ array['order.created','order.updated','order.confirmed','order.cancelled','order.shipped','order.done','order.returned','webhook.test']::text[]);
