# Omni-Commerce Platform — Codex project instructions

## Scope and AI boundaries

This repository contains two independent AI layers:

1. OpenAI Codex is the coding agent. Its model, authentication, approval, and
   sandbox settings belong to the user-level Codex configuration under
   `CODEX_HOME` (normally `~/.codex`).
2. The product AI runtime is `backend/apps/ai`. Its provider settings are
   application environment variables such as `AI_PROVIDER`, `GEMINI_API_KEY`,
   `OPENAI_API_KEY`, and `OPENAI_MODEL`.

Never treat `AI_PROVIDER` or `OPENAI_MODEL` as Codex settings. Do not add
provider, auth, or model-provider overrides to a project `.codex/config.toml`.
Do not change the user-level Codex configuration from a repository task unless
the user explicitly asks for a machine-wide Codex change.

## Other agent configuration

`.claude/`, `.worktrees/`, `.local-secrets/`, `node_modules/`, and runtime
`.env` files are local/generated state. They are not project source of truth.
Do not edit or copy their contents into tracked files. In particular, do not
use `.claude/settings.local.json` as Codex configuration.

## Product AI provider rules

- Local development is offline by default. `pnpm run dev:local` defaults to
  `AI_PROVIDER=stub`, `APP_ENV=local`, and no paid provider calls.
- An intentional local Gemini/OpenAI test may set `AI_PROVIDER=gemini` or
  `AI_PROVIDER=openai` in the parent process. Never commit API keys.
- Staging/production must set `APP_ENV=production` and an explicit primary
  provider. The current deployment uses Gemini as primary and OpenAI as a
  failover; every resolved model must be present in `AI_MODEL_ALLOWLIST`.
- Embeddings remain Gemini-compatible 768-dimensional vectors. Do not switch
  embedding vendor or dimensions without an ADR, migration, and reindex plan.
- AI may call Core API tools through the service boundary. It must not write
  commerce tables directly, bypass tenant authorization/RLS, or log secrets,
  prompts containing PII, or full request bodies.

## Change checklist

When changing provider behavior, update the relevant source, `.env.example`,
`render.yaml`, allowlist defaults, tests, and the applicable runbook together.
Keep Codex instructions separate from runtime provider configuration.

## Verification

- AI service: `cd backend/apps/ai; uv run pytest -q`
- API: `pnpm --filter @omni/api test`
- For configuration-only changes, also verify that no secret value is tracked
  and inspect `git diff --check` before handoff.
