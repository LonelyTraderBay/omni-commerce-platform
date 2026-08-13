## Summary

<!-- What changed and why? Link the issue or task when available. -->

## Scope and risk

- Affected areas: <!-- backend / frontend / AI / database / infra / docs -->
- Risk level: <!-- low / medium / high -->
- Backward compatible: <!-- yes / no; explain -->

## Verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:isolation` (when applicable)
- [ ] `cd backend/apps/ai; uv run pytest -q` (when applicable)
- [ ] Local E2E or targeted smoke test (when applicable)
- [ ] `git diff --check`

Evidence:

```text
<!-- Paste concise commands and results here. Do not paste secrets or PII. -->
```

## Database, contracts, and deployment

- [ ] No database change.
- [ ] Migration added with a unique timestamp and fresh-reset verification.
- [ ] Applied migrations were not edited.
- [ ] OpenAPI/AsyncAPI or client contracts updated when required.
- [ ] Deployment order or feature flags documented when required.

## Security and operations

- [ ] No secret, credential, `.env`, or local runtime artifact is included.
- [ ] Tenant authorization/RLS impact reviewed.
- [ ] Logging and telemetry do not expose secrets, PII, prompts, or full request bodies.
- [ ] Rollout and rollback plan is documented.
- [ ] Runbooks or ADRs updated when operational behavior changed.

## Reviewer notes

<!-- Call out known limitations, follow-up work, or decisions that need review. -->
