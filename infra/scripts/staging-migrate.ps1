# Apply backend/database/supabase/migrations to a linked staging project.
# Requires: SUPABASE_ACCESS_TOKEN, STAGING_PROJECT_REF
# Usage:  pwsh infra/scripts/staging-migrate.ps1
# Optional: -DryRun

param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$SupabaseWorkdir = Join-Path $Root "backend\database"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Error "Missing SUPABASE_ACCESS_TOKEN. Run: supabase login   OR set the env var."
}

$ref = $env:STAGING_PROJECT_REF
if (-not $ref) {
  Write-Error "Missing STAGING_PROJECT_REF (Supabase project ref for staging)."
}

Write-Host "Linking staging project $ref ..."
npx supabase link --project-ref $ref --workdir $SupabaseWorkdir

if ($DryRun) {
  Write-Host "Dry-run db push ..."
  npx supabase db push --workdir $SupabaseWorkdir --dry-run
  exit $LASTEXITCODE
}

Write-Host "Applying migrations (db push) ..."
npx supabase db push --workdir $SupabaseWorkdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "OK — update docs/ops/p0-staging-migrate.md status log."
