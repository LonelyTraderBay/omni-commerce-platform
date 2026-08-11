#Requires -Version 5.1
# Dot-source: . "$PSScriptRoot\Get-OmniLocalPorts.ps1"
function Get-OmniLocalPorts {
  param([string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path)
  $path = Join-Path $RepoRoot "infra\config\local-ports.json"
  if (-not (Test-Path $path)) {
    throw "Missing port lock file: $path"
  }
  return (Get-Content $path -Raw -Encoding utf8 | ConvertFrom-Json)
}

function Test-OmniPortFree {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [string]$Label = "port"
  )
  $hits = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($hits.Count -eq 0) { return $true }
  $procId = $hits[0].OwningProcess
  $name = "?"
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  Write-Warning ("{0} :{1} already in use by PID {2} ({3})" -f $Label, $Port, $procId, $name)
  return $false
}

function Assert-OmniAppPortsFree {
  param($Ports)
  $ok = $true
  $checks = @(
    @{ Port = [int]$Ports.apps.web; Label = "web" },
    @{ Port = [int]$Ports.apps.api; Label = "api" },
    @{ Port = [int]$Ports.apps.ai; Label = "ai" },
    @{ Port = [int]$Ports.apps.inngest; Label = "inngest" }
  )
  foreach ($c in $checks) {
    if (-not (Test-OmniPortFree -Port $c.Port -Label $c.Label)) { $ok = $false }
  }
  if (-not $ok) {
    throw "Omni app ports busy. Stop other stacks or run: pnpm run dev:local:stop"
  }
}
