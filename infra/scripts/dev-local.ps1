#Requires -Version 5.1
param(
  [switch]$NoWeb,
  [switch]$NoApi,
  [switch]$NoAi,
  [switch]$NoInngest,
  [switch]$NoSupabase,
  [switch]$Stop,
  [switch]$SkipPortCheck,
  [switch]$FreshWeb
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root
. (Join-Path $PSScriptRoot "Get-OmniLocalPorts.ps1")
$SupabaseWorkdir = Join-Path $Root "backend\database"
$Ports = Get-OmniLocalPorts -RepoRoot $Root
$HostName = [string]$Ports.host
$PortWeb = [int]$Ports.apps.web
$PortApi = [int]$Ports.apps.api
$PortAi = [int]$Ports.apps.ai
$PortInngest = [int]$Ports.apps.inngest
$UrlWeb = "http://${HostName}:${PortWeb}"
$UrlApi = "http://${HostName}:${PortApi}"
$UrlAi = "http://${HostName}:${PortAi}"
$UrlInngest = "http://${HostName}:${PortInngest}"
$UrlInngestServe = "${UrlApi}/api/inngest"
$UrlSupabase = [string]$Ports.urls.supabase

$pnpmCmd = Join-Path $env:APPDATA "npm\pnpm.cmd"
if (-not (Test-Path $pnpmCmd)) {
  $pnpmCmd = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
}
if (-not $pnpmCmd) { throw "pnpm.cmd not found" }

$npxCmd = Join-Path $env:APPDATA "npm\npx.cmd"
if (-not (Test-Path $npxCmd)) {
  $npxCmd = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
}
if (-not $npxCmd -and (-not $NoInngest -or -not $NoSupabase)) {
  throw "npx.cmd not found (needed for local Supabase/Inngest)"
}

$supabaseCmd = (Get-Command supabase.cmd -ErrorAction SilentlyContinue).Source

function Invoke-SupabaseCli([string[]]$CliArgs) {
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($supabaseCmd) {
      & $supabaseCmd @CliArgs 2>&1
    } else {
      & $npxCmd --yes supabase @CliArgs 2>&1
    }
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  return $LASTEXITCODE
}

$PidFile = Join-Path $Root ".local-secrets\dev-pids.json"
New-Item -ItemType Directory -Force -Path (Join-Path $Root ".local-secrets") | Out-Null

function Stop-ByPort([int]$Port, [string]$Label) {
  $hits = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($h in $hits) {
    $procId = $h.OwningProcess
    if (-not $procId) { continue }
    try {
      & taskkill /PID $procId /T /F 2>$null | Out-Null
      Write-Host ("Stopped {0} on :{1} (pid {2})" -f $Label, $Port, $procId)
    } catch {
      Write-Host ("Skip stop {0} :{1}: {2}" -f $Label, $Port, $_.Exception.Message)
    }
  }
}

function Stop-LocalStack {
  if (Test-Path $PidFile) {
    $saved = Get-Content $PidFile -Raw | ConvertFrom-Json
    foreach ($name in @("api", "web", "ai", "inngest")) {
      $id = $saved.$name
      if ($id) {
        try {
          & taskkill /PID $id /T /F 2>$null | Out-Null
          Write-Host ("Stopped {0} (pid {1})" -f $name, $id)
        } catch {
          try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            Write-Host ("Stopped {0} (pid {1})" -f $name, $id)
          } catch {
            Write-Host ("Skip {0}: {1}" -f $name, $_.Exception.Message)
          }
        }
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "No PID file - cleaning by locked Omni ports..."
  }
  # Always clear locked app ports (orphans / duplicate Inngest)
  Stop-ByPort -Port $PortWeb -Label "web"
  Stop-ByPort -Port $PortApi -Label "api"
  Stop-ByPort -Port $PortAi -Label "ai"
  Stop-ByPort -Port $PortInngest -Label "inngest"
}

if ($Stop) {
  Stop-LocalStack
  if (-not $NoSupabase) {
    Write-Host "Stopping local Supabase..."
    Invoke-SupabaseCli @("stop", "--workdir", "$SupabaseWorkdir") 2>$null | Out-Null
  }
  exit 0
}

Write-Host ("Omni locked ports -> web:{0} api:{1} ai:{2} inngest:{3} (see infra/config/local-ports.json)" -f `
  $PortWeb, $PortApi, $PortAi, $PortInngest)

if (-not $SkipPortCheck) {
  Assert-OmniAppPortsFree -Ports $Ports
}

$EnvFile = Join-Path $Root ".env"
if (-not (Test-Path $EnvFile)) {
  $example = Join-Path $Root ".env.example"
  if (-not (Test-Path $example)) { throw "Missing .env.example" }
  Copy-Item $example $EnvFile -Force
  Write-Host "Created .env from .env.example"
}

function Test-LocalSupabaseHealth {
  try {
    $response = Invoke-WebRequest -Uri "${UrlSupabase}/auth/v1/health" `
      -UseBasicParsing -TimeoutSec 5
    return [int]$response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-SupabaseStatusValues {
  $lines = @(Invoke-SupabaseCli @("status", "--workdir", "$SupabaseWorkdir", "--output", "env") 2>$null)
  $values = @{}
  foreach ($line in $lines) {
    $text = [string]$line
    $eq = $text.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $text.Substring(0, $eq).Trim()
    $value = $text.Substring($eq + 1).Trim()
    if ($key -and $value) { $values[$key] = $value }
  }
  return $values
}

function Set-EnvValues([string]$Path, [hashtable]$Values) {
  if (-not (Test-Path $Path)) { return }
  $lines = Get-Content $Path -Encoding utf8
  $output = New-Object System.Collections.Generic.List[string]
  $seen = @{}
  foreach ($line in $lines) {
    $eq = $line.IndexOf("=")
    if ($eq -lt 1 -or $line -match '^\s*#') {
      $output.Add($line) | Out-Null
      continue
    }
    $key = $line.Substring(0, $eq).Trim()
    if ($Values.ContainsKey($key)) {
      $output.Add($key + "=" + [string]$Values[$key]) | Out-Null
      $seen[$key] = $true
    } else {
      $output.Add($line) | Out-Null
    }
  }
  foreach ($key in $Values.Keys) {
    if (-not $seen.ContainsKey($key)) {
      $output.Add($key + "=" + [string]$Values[$key]) | Out-Null
    }
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($Path, $output.ToArray(), $utf8NoBom)
}

if (-not $NoSupabase) {
  if (-not (Test-LocalSupabaseHealth)) {
    Write-Host "Starting local Supabase..."
    $startExit = Invoke-SupabaseCli @("start", "--workdir", "$SupabaseWorkdir", "--ignore-health-check") 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and $startExit -ne 0) {
      throw "Local Supabase failed to start. Run 'pnpm dlx supabase start' for details."
    }
  } else {
    Write-Host "Local Supabase is already running"
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-LocalSupabaseHealth) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) {
    throw "Local Supabase did not become healthy at ${UrlSupabase}/auth/v1/health"
  }

  $supabaseStatus = Get-SupabaseStatusValues
  if (-not $supabaseStatus.ContainsKey("API_URL") -or
      -not $supabaseStatus.ContainsKey("ANON_KEY") -or
      -not $supabaseStatus.ContainsKey("SERVICE_ROLE_KEY")) {
    throw "Supabase status did not return local API credentials"
  }

  Set-EnvValues -Path $EnvFile -Values @{
    SUPABASE_URL = $supabaseStatus.API_URL
    SUPABASE_ANON_KEY = $supabaseStatus.ANON_KEY
    SUPABASE_SERVICE_ROLE_KEY = $supabaseStatus.SERVICE_ROLE_KEY
    NEXT_PUBLIC_SUPABASE_URL = $supabaseStatus.API_URL
    NEXT_PUBLIC_SUPABASE_ANON_KEY = $supabaseStatus.ANON_KEY
  }
  Set-EnvValues -Path (Join-Path $Root "frontend\apps\web\.env.local") -Values @{
    NEXT_PUBLIC_SUPABASE_URL = $supabaseStatus.API_URL
    NEXT_PUBLIC_SUPABASE_ANON_KEY = $supabaseStatus.ANON_KEY
  }
  Write-Host "Local Supabase credentials synced to .env and frontend/apps/web/.env.local"
}

$uvCandidates = @(
  "$env:APPDATA\Python\Python312\Scripts",
  "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts"
)
foreach ($c in $uvCandidates) {
  if (Test-Path $c) {
    $env:Path = "$c;$env:Path"
  }
}

Write-Host "Installing/syncing deps if needed..."
try { corepack enable | Out-Null } catch {}
pnpm install --prod=false | Out-Null
pnpm --filter @omni/authz-types build | Out-Null
Push-Location (Join-Path $Root "backend\apps\ai")
uv sync
Pop-Location

# backend/apps/ai reads pydantic-settings' `.env` relative to its own directory (see app/config.py),
# same as the README's manual "Copy .env backend/apps/ai/.env -Force" step. Without this, values like
# SERVICE_M2M_KEY silently fall back to the hardcoded default and the API<->AI service-to-service
# calls (e.g. knowledge reindex) fail with 401.
$AiEnvFile = Join-Path $Root "backend\apps\ai\.env"
Copy-Item $EnvFile $AiEnvFile -Force

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path -Encoding utf8) {
    if ($line -match '^\s*#' -or $line.Trim() -eq "") { continue }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { continue }
    if ($line.Substring(0, $eq).Trim() -eq $Key) {
      return $line.Substring($eq + 1).Trim()
    }
  }
  return $null
}

# Fail loudly right here (never silently, as the original bug did) if the copy above didn't
# actually sync the shared M2M secret. Compares values only in-memory - never printed.
$rootM2mKey = Get-EnvValue -Path $EnvFile -Key "SERVICE_M2M_KEY"
$aiM2mKey = Get-EnvValue -Path $AiEnvFile -Key "SERVICE_M2M_KEY"
if ([string]::IsNullOrWhiteSpace($rootM2mKey)) {
  throw "Root .env is missing SERVICE_M2M_KEY - backend/apps/ai <-> backend/apps/api calls would 401."
}
if ($aiM2mKey -ne $rootM2mKey) {
  throw ("backend\apps\ai\.env SERVICE_M2M_KEY does not match root .env after the copy above - " +
    "API<->AI service-to-service calls (e.g. knowledge reindex) will silently 401. " +
    "Check backend\apps\ai\.env was written correctly (see infra\scripts\dev-local.ps1).")
}
Write-Host "backend/apps/ai/.env SERVICE_M2M_KEY verified in sync with root .env"

$logDir = Join-Path $Root ".local-secrets\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pids = @{}

$uvExe = Join-Path $env:APPDATA "Python\Python312\Scripts\uv.exe"
if (-not (Test-Path $uvExe)) {
  $uvExe = (Get-Command uv.exe -ErrorAction SilentlyContinue).Source
}
if (-not $uvExe) { throw "uv.exe not found" }
$aiPythonExe = Join-Path $Root "backend\apps\ai\.venv\Scripts\python.exe"
if (-not (Test-Path $aiPythonExe)) {
  throw "backend\apps\ai\.venv\Scripts\python.exe not found after uv sync"
}

if (-not $env:APP_ENV -or $env:APP_ENV.Trim() -eq "") {
  $env:APP_ENV = "local"
}
$env:APP_ENV = "local"
$env:AI_PROVIDER = "stub"
$env:EINVOICE_PROVIDER = "stub"
$env:EINVOICE_SANDBOX_URL = ""
$env:META_INTEGRATION_MODE = "stub"
$env:SENTRY_DSN = ""
$env:AI_MODEL_ALLOWLIST = "advisor-stub,gemini-2.0-flash"
if (-not $env:EMBEDDINGS_ALLOW_STUB -or $env:EMBEDDINGS_ALLOW_STUB.Trim() -eq "") {
  $env:EMBEDDINGS_ALLOW_STUB = "1"
}

# Force process env to locked ports (overrides stale .env for child processes)
$env:PORT = "$PortApi"
$env:AI_BASE_URL = $UrlAi
$env:CORE_BASE_URL = $UrlApi
$env:NEXT_PUBLIC_API_BASE_URL = $UrlApi
$env:NEXT_PUBLIC_SUPABASE_URL = $UrlSupabase
# Inngest SDK defaults to :8288 when unset; point it at the locked dev-server port so the
# API's self-registration handshake doesn't loop on ECONNREFUSED.
$env:INNGEST_DEV = $UrlInngest
# CORS allow-list for the API; must match the web origin or browser-based calls are blocked.
$env:WEB_ORIGIN = $UrlWeb

if (-not $NoApi) {
  $p = Start-Process -FilePath $pnpmCmd -ArgumentList @("--dir", "backend/apps/api", "dev") `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "api.out.log") `
    -RedirectStandardError (Join-Path $logDir "api.err.log")
  $pids.api = $p.Id
  Write-Host ("API  pid {0}  -> {1}/health" -f $p.Id, $UrlApi)
}

if (-not $NoAi) {
  $p = Start-Process -FilePath $aiPythonExe -ArgumentList @(
      "-m", "uvicorn", "app.main:app", "--reload",
      "--host", $HostName, "--port", "$PortAi"
    ) `
    -WorkingDirectory (Join-Path $Root "backend\apps\ai") -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "ai.out.log") `
    -RedirectStandardError (Join-Path $logDir "ai.err.log")
  $pids.ai = $p.Id
  Write-Host ("AI   pid {0}  -> {1}/health (APP_ENV={2}, stub={3})" -f $p.Id, $UrlAi, $env:APP_ENV, $env:EMBEDDINGS_ALLOW_STUB)
}

if (-not $NoWeb) {
  # Turbopack's on-disk cache (frontend/apps/web/.next) can go stale/corrupt after heavy
  # branch switching while the dev server is running. Symptom: pages serve fine
  # but the browser full-reloads every few seconds, and web.err.log fills with
  # "FATAL: ... Turbopack ... Next.js package not found" panics from
  # hmr_version_state. A plain restart does NOT fix it (the poisoned cache is on
  # disk) - deleting .next does. Run `pnpm run dev:local:fresh` when this hits.
  if ($FreshWeb) {
    $webCache = Join-Path $Root "frontend\apps\web\.next"
    if (Test-Path $webCache) {
      Remove-Item $webCache -Recurse -Force
      Write-Host "FreshWeb: deleted frontend/apps/web/.next (Turbopack cache reset)"
    }
  }
  $p = Start-Process -FilePath $pnpmCmd -ArgumentList @(
    "--dir", "frontend/apps/web", "dev"
  ) `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "web.out.log") `
    -RedirectStandardError (Join-Path $logDir "web.err.log")
  $pids.web = $p.Id
  Write-Host ("Web  pid {0}  -> {1}" -f $p.Id, $UrlWeb)
}

if (-not $NoInngest) {
  $inngestArgs = @(
    "--yes",
    "inngest-cli@latest",
    "dev",
    "-u", $UrlInngestServe,
    "-p", "$PortInngest"
  )
  $p = Start-Process -FilePath $npxCmd -ArgumentList $inngestArgs `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "inngest.out.log") `
    -RedirectStandardError (Join-Path $logDir "inngest.err.log")
  $pids.inngest = $p.Id
  Write-Host ("Inngest pid {0}  -> {1} (serve {2})" -f $p.Id, $UrlInngest, $UrlInngestServe)
}

$pids | ConvertTo-Json | Set-Content $PidFile -Encoding utf8
Write-Host ""
Write-Host "Waiting for health..."
Start-Sleep -Seconds 25

function Probe([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
    $snip = $r.Content
    if ($snip.Length -gt 80) { $snip = $snip.Substring(0, 80) }
    return ("{0} {1}" -f $r.StatusCode, $snip)
  } catch {
    return ("FAIL {0}" -f $_.Exception.Message)
  }
}

Write-Host ("API : {0}" -f (Probe "${UrlApi}/health"))
Write-Host ("AI  : {0}" -f (Probe "${UrlAi}/health"))
Write-Host ("Web : {0}" -f (Probe "${UrlWeb}/"))
if (-not $NoInngest) {
  Write-Host ("Inngest UI : {0}" -f (Probe $UrlInngest))
}
Write-Host ""
Write-Host "Port lock: infra\config\local-ports.json | Sync env: pnpm run ports:sync"
Write-Host "Logs: .local-secrets\logs\"
Write-Host "Stop:  pnpm run dev:local:stop"
Write-Host "Local mode: AI_PROVIDER=stub, EINVOICE_PROVIDER=stub, META_INTEGRATION_MODE=stub, APP_ENV=local"
Write-Host ("Chunks smoke: create product -> docker exec supabase_db_omni-commerce psql -U postgres -d postgres -t -c `"select count(*) from knowledge_chunks;`"")
