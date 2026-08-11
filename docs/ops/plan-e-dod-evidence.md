# Plan E DoD — R1 eng prep vs owner-paid (ops view)

**Date:** 2026-07-25  
**Branch:** `cursor/e2-completion`  
**Canonical Plan E evidence:** [`docs/superpowers/plans/plan-e-dod-evidence.md`](../superpowers/plans/plan-e-dod-evidence.md)  
**Harness:** `backend/apps/api/src/modules/billing/entitlement-gate.proof.spec.ts`
**Architecture:** stub/invoice + plan flags (ADR 0004) — **no** Stripe/PayOS, **no** invented Supabase Pro.

## Eng-proven (R1 eng prep — GREEN without paid billing)

| Gate | Behavior | Proof |
|------|----------|-------|
| `max_pages` | Connect beyond plan limit → **403** `max_pages_exceeded` | `entitlement-gate.proof.spec.ts` + `channels.service.spec.ts` |
| `auto_confirm` | Plan/entitlement disallows or `past_due` → auto-confirm **blocked** (draft path; soft dunning) | `entitlement-gate.proof.spec.ts` + `entitlements.service.spec.ts` + `orders.service.spec.ts` |
| Plan catalog | `free` = `maxPages: 1`, `autoConfirmAllowed: false` | `plan-catalog.ts` asserted in proof harness |
| Billing module | Invoice + plan flags, ops PATCH plan, usage meters | ADR 0004 · `BillingModule` |

## Owner-paid / live (still AMBER — not eng-claimable)

| Item | Why still owner |
|------|-----------------|
| R1.0 Supabase Pro + PITR | Paid project upgrade |
| R1.1 Restore drill | Owner executes runbook on Pro |
| R1.2 Always-on hosts | Render/Railway paid tier |
| R1.3 Uptime + on-call | Vendor monitors + human rota |
| R1.4 LLM paid + live cap prove | Real API keys on staging/prod |
| R1.5 Billing **live** ops log | Ops sets pilot plan on real org + ticket evidence |
| R1.6 Close Plan E paid rows GREEN | Depends on R1.0–R1.5 |

**Honest split:** entitlement **code gates** are eng-proven; R1 **live/paid** rows remain owner-blocked until Pro/PITR/always-on/LLM keys/ops tickets land.
