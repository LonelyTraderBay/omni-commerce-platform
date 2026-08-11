-- At most one *active* e-invoice job per order.
--
-- `EinvoiceService.issue()` used to insert a job and call `provider.issue(...)`
-- unconditionally, and `einvoice_jobs` only had non-unique indexes
-- (20260727200000_supplier_po_einvoice.sql). A double-click, a client retry or
-- two operators acting at once therefore issued TWO legal tax invoices for one
-- sale. The service now looks up an active job before calling the provider;
-- this index is the backstop that makes that check race-proof, so two
-- concurrent inserts collide on 23505 instead of both reaching the provider.
--
-- Status vocabulary (einvoice_jobs_status_check, 20260727200000):
--   'pending' | 'sent' | 'failed' | 'dead'
-- Only 'pending' and 'sent' are active. 'failed' and 'dead' are terminal
-- failures that MUST stay retryable -- which is exactly why the index is
-- partial: a dead job must never wedge an order out of ever being invoiced.
--
-- Note: this index will fail to build if an org already has two active jobs on
-- one order. That is intentional. Duplicate legal invoices cannot be resolved
-- by a data migration -- somebody has to cancel one at the provider and with
-- the tax authority first.

create unique index if not exists einvoice_jobs_one_active_per_order_idx
  on public.einvoice_jobs (org_id, order_id)
  where status in ('pending', 'sent');
