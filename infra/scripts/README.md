# infra/scripts/

Repo helper scripts for **local** Omni Commerce stack. Paths are resolved from `$PSScriptRoot` / `import.meta.url` — never hardcode machine-absolute paths.

| Script | Purpose |
|--------|---------|
| `dev-local.ps1` | Start/stop local Supabase + web + api + ai + Inngest (`pnpm run dev:local`) |
| `Get-OmniLocalPorts.ps1` | Load locked ports from `infra/config/local-ports.json` |
| `sync-local-env-ports.ps1` | Sync `.env` / app env URLs to locked ports (`pnpm run ports:sync`) |
| `local-e2e-smoke.mjs` | Local smoke checks (`pnpm run test:e2e:local`) |
| `staging-migrate.ps1` | Staging migration helper (owner/CI path) |

Port SoT: [`infra/config/local-ports.json`](../config/local-ports.json) · docs: [`docs/ops/local-ports.md`](../../docs/ops/local-ports.md).

`dev-local.ps1` owns the local development profile: it starts Supabase when
needed, synchronizes local API credentials into ignored env files, forces
`APP_ENV=local`, selects deterministic AI/e-invoice providers, and stops the
same stack with `pnpm run dev:local:stop`. Use `-NoSupabase` only when another
local Supabase process already owns the configured project.
