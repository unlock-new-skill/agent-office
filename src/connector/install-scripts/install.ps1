# Agent Office connector installer for Windows (PowerShell).
# Usage (the manager copies this from Org -> Add machine):
#   $env:AGENT_OFFICE_CODE='<install-code>'; irm __ORIGIN__/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Origin = '__ORIGIN__'
$Code = $env:AGENT_OFFICE_CODE
if (-not $Code) { Write-Host "usage: `$env:AGENT_OFFICE_CODE='<install-code>'; irm $Origin/install.ps1 | iex" -ForegroundColor Red; return }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js 20+ is required: https://nodejs.org' -ForegroundColor Red; return }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Write-Host "Node.js 20+ is required; found $(& node -v)." -ForegroundColor Red; return }
$base = if ($env:AGENT_OFFICE_HOME) { $env:AGENT_OFFICE_HOME } else { Join-Path $env:USERPROFILE '.agent-office' }
$dir = Join-Path $base 'bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir 'agent-office.mjs'
Invoke-WebRequest -UseBasicParsing -Uri "$Origin/connector/agent-office.mjs" -OutFile "$file.tmp"
Move-Item -Force "$file.tmp" $file
& node $file install --url $Origin --code $Code
Remove-Item Env:AGENT_OFFICE_CODE -ErrorAction SilentlyContinue
