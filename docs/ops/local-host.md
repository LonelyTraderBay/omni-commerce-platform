# Local host mode (PC as server)

> **SoT local ports (current):** [`infra/config/local-ports.json`](../../infra/config/local-ports.json) · [`local-ports.md`](./local-ports.md)
> Web **4700** · API **4701** · AI **4702** · Inngest **4788** · Supabase API **54721**.  
> Rows below that still mention `:3000` / `:3001` / `:8000` / `:54321` are **legacy evidence** — do **not** use those ports for new runs.

Full local stack: Supabase (Docker) + API + Web + AI on this machine.

**Port lock (anti-collision):** [`local-ports.md`](./local-ports.md) · SoT `infra/config/local-ports.json`
Omni uses **4700 / 4701 / 4702 / 4788 / 54721+** — not the common `3000/3001/8000/54321` block.

> **Default for coding / SDD (2026-07-26):** Local-first is the default development surface. Render staging payment / Starter and Meta App Review are **deferred** until owner wants to **claim CPC thương mại** (Gate R0 live) — see [L1 plan](../superpowers/plans/2026-07-26-sdd-l1-local-first.md) and [completion-step-by-step](../superpowers/plans/2026-07-25-completion-step-by-step.md).

## Prerequisites

- Docker Desktop running (`docker` on PATH, or `C:\Program Files\Docker\Docker\resources\bin`)
- Node 22+, pnpm, Python 3.12, `uv`

## Start database

```powershell
$env:Path = "C:\Program Files\Docker\Docker\resources\bin;$env:Path"
npx supabase start --workdir backend/database
npx supabase status --workdir backend/database -o env
```

If Omni Supabase ports (`54721`+) conflict, stop the other stack — do **not** change Omni ports ad-hoc; edit `infra/config/local-ports.json` + `backend/database/supabase/config.toml` together.

```powershell
npx supabase stop --project-id omni-commerce --workdir backend/database
npx supabase start --workdir backend/database
```

## Point apps at local Supabase

```powershell
pnpm run ports:sync
```

`.env`, `frontend/apps/web/.env.local`, `backend/apps/ai/.env` must use:

- `SUPABASE_URL=http://127.0.0.1:54721` (locked)
- local anon / service_role keys from `supabase status --workdir backend/database`

## Start / stop apps

```powershell
pnpm run dev:local
pnpm run dev:local:stop
```

`dev:local` starts **API + Web + AI + Inngest Dev Server** (separate process).  
Inngest CLI (locked): `npx --yes inngest-cli@latest dev -u http://127.0.0.1:4701/api/inngest -p 4788`  
Skip one service: `infra/scripts/dev-local.ps1 -NoInngest` (also `-NoApi` / `-NoWeb` / `-NoAi`).

AI process gets `APP_ENV=local` and `EMBEDDINGS_ALLOW_STUB=1` when unset so stub embeddings work without Gemini.

## URLs (locked — [local-ports.md](./local-ports.md))

| Service | URL |
|---------|-----|
| Web | http://127.0.0.1:4700 |
| API | http://127.0.0.1:4701/health |
| AI | http://127.0.0.1:4702/health |
| Inngest Dev UI | http://127.0.0.1:4788 |
| Supabase API | http://127.0.0.1:54721 |
| Studio | http://127.0.0.1:54723 |
| Mailpit | http://127.0.0.1:54724 |

### L1 Task 2 stack verify (2026-07-26) — *legacy evidence* (pre-port-lock)

Ports in this table (`:54321` etc.) predate the Omni lock — **current SoT is 4700/4701/4702/4788/54721** ([local-ports.md](./local-ports.md)). Kept for history only.

| Check | Result |
|-------|--------|
| Docker Desktop + `npx supabase status` | **PASS** — `API_URL=http://127.0.0.1:54321`; project `omni-commerce` |
| Env alignment | **PASS** — parent `.env` + `apps/web/.env.local` use `127.0.0.1:54321` (worktree shares parent secrets; not committed) |
| api `GET /health` | **PASS** — HTTP 200 `{"status":"ok"}` |
| ai `GET /health` | **PASS** — HTTP 200 `{"status":"ok"}` |
| web `GET /` | **PASS** — HTTP 200 (`Omni Commerce`) |
| Supabase auth health | **PASS** — `GET http://127.0.0.1:54321/auth/v1/health` 200 |
| Meta webhooks | **BLOCKED** — localhost not callable by Meta (expected) |

## Knowledge reindex (`knowledge_chunks`)

Product create enqueues `knowledge.reindex` via outbox → Inngest → AI embed → `replace_knowledge_chunks`.
Without Inngest, chunks stay empty even though the product exists.

**Default (L2):** `pnpm run dev:local` already starts Inngest. Manual companion (only if `-NoInngest` or debugging):

```powershell
npx --yes inngest-cli@latest dev -u http://127.0.0.1:4701/api/inngest -p 4788
```

*(Legacy evidence below may still show `-u …:3001` — that was pre-port-lock; do not use for new runs.)*

### Embeddings: Gemini vs local stub

| Mode | When | Quality |
|------|------|---------|
| **Gemini** | `GEMINI_API_KEY` set (non-empty) | Real `text-embedding-004` (768-d) |
| **Local stub** | Key empty **and** (`APP_ENV` ∈ local/dev/test **or** `EMBEDDINGS_ALLOW_STUB=1`) | Deterministic hash vectors (768-d). **Not** Gemini quality; **not** for CPC/live-LLM claims |
| **Refused** | Key empty **and** `APP_ENV`/`NODE_ENV` = `production` (even if allow flag set) | Clear error — stub never silent in prod |

Enable stub for local-only (key already empty on this PC — probe `GEMINI_API_KEY` len=0):

```powershell
# parent .env and/or apps/ai/.env
APP_ENV=local
# optional explicit flag (needed if APP_ENV is neither local/dev/test):
EMBEDDINGS_ALLOW_STUB=1
```

Restart AI after env changes (`pnpm run dev:local` or restart AI process).

Unit coverage: `uv run --directory backend/apps/ai pytest tests/test_stub_embeddings.py -q`

### E0.2 local verify (2026-07-26 · L1 Task 3)

| Step | Result |
|------|--------|
| `GEMINI_API_KEY` probe (parent `.env`, value len only) | **EMPTY** — len=0 → stub path (not live Gemini) |
| Stub embeddings code | **PASS** — `apps/ai` factory + `StubEmbeddingProvider` (768-d, labeled `local-stub-embeddings`) |
| Prod guard | **PASS** — stub refused when `APP_ENV`/`NODE_ENV=production` even with `EMBEDDINGS_ALLOW_STUB=1` |
| `uv run pytest tests/test_stub_embeddings.py -q` | **PASS** — see commit evidence |
| Create product + Inngest → `knowledge_chunks` > 0 | **ENG PATH READY** (L2 Task 3) — `dev:local` bundles Inngest; smoke commands below |

### L2 Task 3 — Inngest in `dev:local` (2026-07-26) — *legacy evidence* (pre-port-lock)

Inngest URL in this table used legacy API `:3001`. **Current SoT:** `-u http://127.0.0.1:4701/api/inngest -p 4788`.

| Check | Result |
|-------|--------|
| `dev:local` starts Inngest | **PASS** — `scripts/dev-local.ps1` pid `inngest`; `-u http://127.0.0.1:3001/api/inngest` |
| `dev:local:stop` stops Inngest | **PASS** — process tree kill includes `inngest` |
| Stub embeddings env | **PASS** — sets `APP_ENV=local` + `EMBEDDINGS_ALLOW_STUB=1` when unset |
| Live `knowledge_chunks` > 0 | **PASS** (2026-07-26 smoke) — stub reindex wrote 1 chunk; count `> 0` |

**Verify chunks smoke:**

```powershell
# 1) Stack with Inngest (one command)
pnpm run dev:local
# 2) APP_ENV=local / EMBEDDINGS_ALLOW_STUB already set by script when unset; GEMINI empty OK
# 3) Authenticate, then POST /v1/catalog/products for an org (web UI or API)
# 4) Wait ~10–30s for outbox → knowledge.reindex, then:
$env:Path = "C:\Program Files\Docker\Docker\resources\bin;$env:Path"
docker exec supabase_db_omni-commerce psql -U postgres -d postgres -t -c "select count(*) from knowledge_chunks;"
# Expect count > 0 (stub vectors). Logs: .local-secrets\logs\inngest.*.log
```

Expect `> 0` with stub vectors. **Do not** claim Gemini retrieval / CPC quality from stub chunks.

### L3 Task 2 — walkthrough smoke reconfirm (2026-07-26) — *legacy evidence* (pre-port-lock)

Ports `:8000` / Inngest `:8288` below are historical. **Current SoT:** AI **4702**, Inngest **4788**.

| Check | Result |
|-------|--------|
| Stack (api/web/ai/Inngest/Supabase) | **PASS** — health 200s; Inngest `:8288` |
| Invite create + accept | **PASS** — cskh + kho memberships via `POST /v1/invites/accept` |
| Draft → confirm + export CSV | **PASS** — `confirmed`; export HTTP 200 |
| Product → `knowledge_chunks` > 0 (stub) | **PASS** — after clearing orphan AI on `:8000` (spawn child kept old Gemini-only process); restart AI with `APP_ENV=local` + `EMBEDDINGS_ALLOW_STUB=1` |
| Meta OAuth / DM | **BLOCKED** — localhost (expected) |

If `POST .../reindex` returns `502 {"detail":"GEMINI_API_KEY is required for embeddings"}` while logs claim stub: check for a **zombie** Python/uvicorn still bound to the **locked AI port** (`Get-NetTCPConnection -LocalPort 4702`; kill orphan `multiprocessing.spawn` children), then restart AI only. *(Legacy runs used `:8000`.)*

### L3 Task 3 — A2 local e2e smoke (API script)

One command proves the non-Meta happy path against a running local stack (no Playwright, no Meta, no Render).

**Prerequisites**

1. Docker Desktop up; local Supabase (`npx supabase start --workdir backend/database`)
2. `.env` at repo root (or worktree) with `SUPABASE_URL=http://127.0.0.1:54721` + local `SUPABASE_ANON_KEY` (`pnpm run ports:sync`)
3. Apps up: `pnpm run dev:local` — API must answer `GET http://127.0.0.1:4701/health` → `{"status":"ok"}` (script **fails clearly** if health is down)

**Run**

```powershell
pnpm run test:e2e:local
# or: node infra/scripts/local-e2e-smoke.mjs
# optional: $env:API_BASE_URL = "http://127.0.0.1:4701"
```

**Covers:** health → signup owner+cskh → `POST /v1/orgs` → invite create+accept → catalog product → inventory adjust → draft order → confirm → `GET /v1/orders/export?format=csv`.

### Prior E0.2 note (2026-07-25 · sdd-task-2)

| Step | Result |
|------|--------|
| Stack + Inngest | **PASS** — product/outbox published |
| `knowledge_chunks` | Was **BLOCKED** on `502 GEMINI_API_KEY is required` — unblocked by L1 Task 3 stub path above |

## Meta webhooks

Meta cannot call localhost. Use Cloudflare Tunnel / ngrok when testing webhooks.

## Known fix: order confirm after multi-warehouse

Orgs created without a default warehouse caused `POST /v1/orders/:id/confirm` → `500 orders_failed`.
Migration `20260727210000_ensure_default_warehouse_on_org.sql` creates `Kho chính` / `MAIN` on
org insert and backfills existing orgs. Apply locally with
`npx supabase db reset --workdir backend/database` or
`npx supabase migration up --workdir backend/database`.
