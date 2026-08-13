# Git Governance

This document is the repository source of truth for branch lifecycle, merge
policy, release tags, and local graph hygiene.

## Repository model

`main` is the only long-lived branch. Feature, fix, documentation, and
automation branches are short-lived and are integrated through pull requests.
The default merge method is **Squash and merge**, so one product change has one
first-parent commit on `main`.

Use a merge commit only when preserving release or hotfix topology is useful
for incident or audit evidence. Do not merge `origin/main` repeatedly into a
short-lived feature branch; rebase it instead.

## Required GitHub settings

The repository administrator should protect `main` with:

- Pull request required; direct pushes disabled except for an emergency owner
  path.
- Required approval from CODEOWNERS.
- Required, up-to-date CI checks for the affected API, web, AI, isolation,
  migration, and security paths.
- Stale approvals dismissed when new code is pushed.
- Conversation resolution required.
- Force-push and branch deletion disabled.
- Squash merge enabled; merge commits and rebase merges disabled by default.

`CODEOWNERS` currently has one maintainer. When distinct backend, frontend, and
platform owners exist, split ownership by `/backend/`, `/frontend/`, `/infra/`,
and `/docs/adr/` rather than inventing placeholder teams.

## Branch lifecycle

```powershell
git fetch origin --prune
git switch -c feat/ORD-123-short-name origin/main
# work and commit
git rebase origin/main
git push -u origin HEAD
```

After merge, delete the remote and local feature branch. Local refs named
`worktree-agent-*` are disposable runtime state and must not be retained after
their worktree is gone. A branch with unique work that is intentionally kept
must be renamed under `archive/`, have no upstream, and be recorded in the
handoff notes.

## Commit policy

Commit subjects use:

```text
type(scope): imperative summary
```

The `PR Policy` workflow enforces the subject format for pull requests and
rejects whitespace errors. Existing historical commits are not rewritten; the
policy applies to new work.

## Release policy

1. Merge the release changes into `main` using the normal protected-branch
   workflow.
2. Update `CHANGELOG.md` with the version, date, migration notes, verification,
   and rollback notes.
3. Verify `main` is clean and synchronized:

   ```powershell
   git switch main
   git pull --ff-only origin main
   git diff --check
   ```

4. Create and push an annotated SemVer tag:

   ```powershell
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin v1.0.0
   ```

The `Release Validate` workflow rejects tags that are not SemVer or that do
not point to a commit reachable from `origin/main`. The `SBOM` workflow runs
for `v*` tags and attaches the generated SPDX SBOM to a GitHub Release when one
exists.

Every production release should retain the following evidence:

- Version tag and commit SHA.
- CI and migration results.
- SBOM artifact.
- Deployment timestamp and environment.
- Rollback target and any required migration procedure.

## Local graph hygiene

Use first-parent history for the release narrative:

```powershell
git log --first-parent --graph --decorate --oneline main
```

Before deleting a local branch, check whether it contains work not in `main`:

```powershell
git cherry main <branch>
git log --oneline main..<branch>
```

Only delete a branch when its unique commits are either merged, intentionally
archived, or explicitly discarded. Run `git fetch origin --prune` regularly to
remove remote-tracking refs for branches already deleted on GitHub.
