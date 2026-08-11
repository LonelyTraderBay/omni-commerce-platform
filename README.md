# Omni Commerce

Monorepo for the Vietnamese omni-commerce operating system. The repository is
split into clear ownership boundaries so backend services, frontend applications,
database assets, and operational tooling can evolve independently.

## Repository layout

- `backend/apps/api`: NestJS core API — locked port **`4701`**.
- `backend/apps/ai`: FastAPI AI service — locked port **`4702`**.
- `backend/packages`: backend-only shared packages and API contracts.
- `backend/database/supabase`: local database config, migrations, and seed — locked API **`54721`**.
- `backend/tests`: isolation, evaluation, and backend fixtures.
- `frontend/apps/web`: Next.js web application — locked port **`4700`**.
- `infra/config`: local environment source-of-truth such as locked ports.
- `infra/scripts`: local development, smoke-test, and staging operations.
- Port lock (avoid collisions with other repos): [`docs/ops/local-ports.md`](docs/ops/local-ports.md).

## Prerequisites

- Node.js with Corepack and `pnpm@9.15.0`.
- Python `3.12`.
- `uv` for the AI service.
- Supabase CLI and Docker for local Supabase.

## Local development profile

Development is local-first. `pnpm run dev:local` starts or reuses local Supabase
and starts all application services on the locked ports below. It also syncs
the local Supabase API/keys into `.env` and `frontend/apps/web/.env.local` without
printing secrets.

The local profile uses deterministic, in-process providers by default:

- AI embeddings and completions: local stub (`AI_PROVIDER=stub` in the child processes)
- E-invoice: `stub`
- Shipping: `manual` or the explicit GHN mock option
- Meta OAuth/page discovery/message sends: local stub (`META_INTEGRATION_MODE=stub`)
- Sentry and paid provider calls: disabled unless explicitly enabled outside local mode

Create the env file once if needed:

```powershell
Copy-Item .env.example .env
```

Then start the complete local stack:

```powershell
pnpm run dev:local:fresh
```

Stop Web, API, AI, Inngest and local Supabase together:

```powershell
pnpm run dev:local:stop
```

Use `AI_PROVIDER=gemini` or `AI_PROVIDER=openai` only for an intentional
external-provider test. Do not put production credentials in the local profile.

## Supabase troubleshooting

```powershell
pnpm dlx supabase status --workdir backend/database
pnpm dlx supabase db reset --workdir backend/database
```

`db reset` is destructive to local test data and is not run automatically. The
normal `dev:local` command only starts containers and applies pending migrations.

The local script automatically syncs the following values from Supabase status:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Install dependencies manually (optional)

```powershell
corepack enable
pnpm install
uv sync --directory backend/apps/ai
```

## Service URLs

Health checks (locked):

- Web: `http://127.0.0.1:4700`
- API: `http://127.0.0.1:4701/health` and `http://127.0.0.1:4701/ready`
- AI: `http://127.0.0.1:4702/health`
- Inngest: `http://127.0.0.1:4788`
- Supabase: `http://127.0.0.1:54721`

## Quality checks

`pnpm lint` and `pnpm typecheck` both run `tsc --noEmit` via Turbo across `@omni/api`, `@omni/web`, `@omni/authz-types`, and `@omni/db`. There is no ESLint config in this monorepo (Gate A A3: honesty over an empty flat config).

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:isolation
uv run --directory backend/apps/ai pytest -q
python backend/tests/eval/run_stub.py
```

## Manual smoke

The one-shot local command starts Docker Supabase, API, AI, Web and Inngest:

```powershell
pnpm run dev:local:fresh
```

Then probe API `/health` and `/ready`, AI `/health`, web shell, `GET /internal/v1/ai/health` with `X-Service-Key`, and insert a `platform.noop` outbox row to confirm Inngest receives it.

## Meta webhook (local)

1. Chạy local stack: `pnpm run dev:local` (API **:4701**)
2. Tunnel: `cloudflared tunnel --url http://127.0.0.1:4701` (hoặc ngrok)
3. Meta Webhook Callback URL: `https://<tunnel>/v1/webhooks/meta`
4. Verify token = `META_VERIFY_TOKEN`

OAuth redirect (Facebook Login) dùng web app, không qua tunnel API:

- `META_REDIRECT_URI=http://127.0.0.1:4700/settings/channels/callback`
- Trong Meta App → Facebook Login → Valid OAuth Redirect URIs: cùng giá trị trên.

Chạy Inngest (đã gồm trong `dev:local`):

```powershell
npx inngest-cli@latest dev -u http://127.0.0.1:4701/api/inngest -p 4788
```

Xem thêm runbook: [docs/runbooks/meta-down.md](./docs/runbooks/meta-down.md).

## Pilot / Meta App Review (staging)

Trước khi onboard shop pilot hoặc nộp Meta App Review:

1. Deploy staging web + API (always-on; webhook không cold-start).
2. Legal public: `https://<app-host>/legal/privacy` và `/legal/terms`.
3. Webhook prod/staging: `https://<api-host>/v1/webhooks/meta` + `META_VERIFY_TOKEN`.
4. OAuth redirect: `https://<app-host>/settings/channels/callback` (= `META_REDIRECT_URI`).

Checklist đầy đủ (permissions, test Page/IG, screencast): [docs/meta-app-review-checklist.md](./docs/meta-app-review-checklist.md).
