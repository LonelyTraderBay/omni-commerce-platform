#Requires -Version 5.1
<#
.SYNOPSIS
  Patch local env files to match infra/config/local-ports.json (Omni locked ports).
  Does not print secret values - only updates URL/PORT keys.
#>
param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
. (Join-Path $PSScriptRoot "Get-OmniLocalPorts.ps1")
$P = Get-OmniLocalPorts -RepoRoot $Root

$hostName = [string]$P.host
$web = [int]$P.apps.web
$api = [int]$P.apps.api
$ai = [int]$P.apps.ai
$sb = [int]$P.supabase.api
$inngest = [int]$P.apps.inngest

$replacements = [ordered]@{
  "PORT"                        = "$api"
  "SUPABASE_URL"                = "http://${hostName}:${sb}"
  "NEXT_PUBLIC_SUPABASE_URL"    = "http://${hostName}:${sb}"
  "NEXT_PUBLIC_API_BASE_URL"    = "http://${hostName}:${api}"
  "AI_BASE_URL"                 = "http://${hostName}:${ai}"
  "CORE_BASE_URL"               = "http://${hostName}:${api}"
  "META_REDIRECT_URI"           = "http://${hostName}:${web}/settings/channels/callback"
  "API_BASE_URL"                = "http://${hostName}:${api}"
  "INNGEST_DEV"                 = "http://${hostName}:${inngest}"
  "WEB_ORIGIN"                  = "http://${hostName}:${web}"
}

function Update-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) {
    Write-Host ("skip (missing): {0}" -f $Path)
    return
  }
  $lines = Get-Content $Path -Encoding utf8
  $out = New-Object System.Collections.Generic.List[string]
  $seen = @{}
  foreach ($line in $lines) {
    if ($line -match '^\s*#' -or $line.Trim() -eq "") {
      $out.Add($line) | Out-Null
      continue
    }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) {
      $out.Add($line) | Out-Null
      continue
    }
    $key = $line.Substring(0, $eq).Trim()
    if ($replacements.Contains($key)) {
      $out.Add(($key + "=" + [string]$replacements[$key])) | Out-Null
      $seen[$key] = $true
    } else {
      $out.Add($line) | Out-Null
    }
  }
  foreach ($key in $replacements.Keys) {
    if (-not $seen.ContainsKey($key)) {
      # Only append keys that are commonly expected in that file
      if ($Path -match '\\apps\\web\\' -and $key -notmatch 'NEXT_PUBLIC_|API_BASE') { continue }
      if ($Path -match '\\apps\\ai\\' -and $key -notin @("CORE_BASE_URL", "APP_ENV")) { continue }
    }
  }
  if ($DryRun) {
    Write-Host ("DRY-RUN would update: {0}" -f $Path)
    return
  }
  # PS 5.1 -Encoding utf8 writes BOM; supabase CLI rejects BOM in .env
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($Path, $out.ToArray(), $utf8NoBom)
  Write-Host ("updated: {0}" -f $Path)
}

Write-Host ("Omni ports: web={0} api={1} ai={2} supabase={3} inngest={4}" -f `
  $web, $api, $ai, $sb, [int]$P.apps.inngest)

Update-EnvFile (Join-Path $Root ".env")
Update-EnvFile (Join-Path $Root ".env.example")
Update-EnvFile (Join-Path $Root "frontend\apps\web\.env.local")
Update-EnvFile (Join-Path $Root "backend\apps\ai\.env")

Write-Host ""
Write-Host "Next (if Supabase still on old ports):"
Write-Host "  npx supabase stop --workdir backend/database"
Write-Host "  npx supabase start --workdir backend/database"
Write-Host "  pnpm run dev:local:stop"
Write-Host "  pnpm run dev:local"
