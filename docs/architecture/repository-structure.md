# Enterprise repository structure

The repository uses a small number of explicit ownership boundaries. Keep
deployable applications separate from reusable packages, database source, and
operational tooling.

```text
.
├── backend/
│   ├── apps/
│   │   ├── api/                  # NestJS core API and Inngest functions
│   │   └── ai/                   # FastAPI AI/RAG service
│   ├── packages/
│   │   ├── authz-types/          # Shared roles and permissions
│   │   ├── db/                   # Shared database-facing types
│   │   ├── contracts/            # OpenAPI/API contract source of truth
│   │   └── api-client/           # Deprecated placeholder; web client is the runtime SoT
│   ├── database/
│   │   └── supabase/             # config.toml, migrations, seed
│   └── tests/
│       ├── isolation/            # Cross-tenant/RLS verification
│       ├── eval/                 # AI golden/adversarial evaluation
│       └── fixtures/             # Backend test fixtures
├── frontend/
│   └── apps/
│       └── web/                  # Next.js web application
├── infra/
│   ├── config/                   # Local ports and operational source-of-truth
│   └── scripts/                  # Local, smoke-test, and staging helpers
├── docs/                         # Architecture, ADRs, runbooks, and project records
├── .github/                      # CI/CD and repository automation
├── .env.example                  # Root development environment template
├── package.json                  # Root commands and Turbo entry point
└── pnpm-workspace.yaml           # Backend/frontend workspace boundaries
```

## Working rules

- Add a new deployable backend service under `backend/apps/<service>`.
- Add backend-only reusable code under `backend/packages/<package>`.
- Add a new frontend application under `frontend/apps/<app>`.
- Put migrations and Supabase configuration only under `backend/database/supabase`.
- Put local ports and process orchestration under `infra`; do not duplicate port
  values in application code.
- Keep root commands stable (`pnpm dev:local`, `pnpm test`, `pnpm build`, and
  similar). Developers should not need to know internal process paths for normal
  workflows.
- Do not move tenant isolation, RLS, idempotency, audit, outbox, or service-key
  boundaries between folders without updating their tests and ADRs.

## Canonical commands

```powershell
pnpm install
pnpm run dev:local:fresh
pnpm test
pnpm test:isolation
pnpm test:eval
pnpm run test:e2e:local
pnpm run dev:local:stop
```
