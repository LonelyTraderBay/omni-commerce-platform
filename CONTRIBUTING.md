# Contributing

This repository uses a short-lived branch and pull-request workflow. `main`
is the only long-lived development and release branch.

## Branches

Use a descriptive branch prefix and keep the branch focused:

- `feat/<issue>-<short-name>`
- `fix/<issue>-<short-name>`
- `chore/<short-name>`
- `docs/<short-name>`
- `refactor/<short-name>`
- `test/<short-name>`
- `hotfix/<issue>-<short-name>`

Do not commit generated agent/worktree refs, local runtime artifacts, secrets,
or unrelated changes to a feature branch. Delete a branch after its pull
request is merged. A branch with work that is intentionally retained but not
active must be clearly named under `archive/` and must not track a remote.

## Keeping a branch current

Before opening or updating a pull request:

```powershell
git fetch origin --prune
git rebase origin/main
```

Rebase short-lived branches instead of repeatedly merging `main` into them.
Do not force-push `main`; force-push is acceptable only for a private feature
branch after confirming that nobody else depends on it.

## Commit and pull-request titles

Use a Conventional Commit subject:

```text
type(scope): imperative summary
```

Allowed types are `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`,
`ci`, `build`, and `revert`. Keep the subject concise and add an issue or PR
reference when one exists, for example `fix(data): prevent duplicate shipment (#67)`.

The pull-request title is the final commit subject when squash merging, so it
must follow the same format. The repository PR policy workflow checks the
branch name, PR title, commit subjects, and whitespace errors.

## Pull requests

Every pull request must explain the change, risk, verification, migration
impact, rollout plan, and rollback plan. Use the repository pull-request
template and keep unrelated refactors out of the PR.

Required checks depend on the affected area and normally include API, web,
AI, isolation, migration, and security checks. A reviewer must explicitly
confirm database and security changes before merge.

The default integration method is **Squash and merge**. Preserve merge commits
only for release or emergency hotfix coordination where the topology itself is
important evidence.

## Database and contracts

- Give every migration a unique UTC timestamp and never edit an applied
  migration.
- Run a fresh database reset when changing migrations or RLS.
- Update OpenAPI/AsyncAPI contracts and their tests when an API shape changes.
- State whether a change is backward compatible and whether deployment order
  matters.

## Verification

Run the smallest complete set locally before opening a PR:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:isolation
cd backend/apps/ai
uv run pytest -q
```

For configuration-only changes, also run `git diff --check` and verify that no
secret or runtime `.env` file is tracked.

## Releases

Releases are annotated SemVer tags created from `main`, for example:

```powershell
git switch main
git pull --ff-only origin main
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

The release tag must point to a commit reachable from `main`. The release
validation workflow checks this invariant, and the SBOM workflow generates and
publishes the release SBOM for `v*` tags. See
`docs/ops/git-governance.md` for the complete release and branch policy.
