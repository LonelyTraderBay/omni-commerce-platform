-- Allow http_sandbox e-invoice provider alongside stub (R2.5 eng path).
alter table public.einvoice_jobs
  drop constraint if exists einvoice_jobs_provider_check;

alter table public.einvoice_jobs
  add constraint einvoice_jobs_provider_check
  check (provider in ('stub', 'http_sandbox'));
