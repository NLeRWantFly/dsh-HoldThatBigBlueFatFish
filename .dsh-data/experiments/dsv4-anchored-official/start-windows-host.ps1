param(
  [string]$SourceRoot = (Get-Location).Path,
  [int]$Port = 3090
)

$ErrorActionPreference = 'Stop'
$ExperimentRoot = $PSScriptRoot
$PresetSource = [System.IO.Path]::GetFullPath((Join-Path $ExperimentRoot '..\..\.agent-presets'))
$RuntimeHome = Join-Path $ExperimentRoot 'runtime\windows-home'

if (-not $env:DEEPSEEK_API_KEY) {
  throw 'MISSING_CREDENTIAL: set a rotated DEEPSEEK_API_KEY in this process before starting the host.'
}
if ($env:DEEPSEEK_BASE_URL -and $env:DEEPSEEK_BASE_URL.TrimEnd('/') -ne 'https://api.deepseek.com') {
  throw 'DEEPSEEK_BASE_URL must be https://api.deepseek.com'
}

node (Join-Path $ExperimentRoot 'prepare-presets.mjs')
New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeHome '.agent-presets') | Out-Null
foreach ($Preset in @(
  'dsv4-official-standard-full',
  'dsv4-official-minimal-full',
  'dsv4-official-standard-anchored',
  'dsv4-official-minimal-fixed',
  'dsv4-official-minimal-anchored'
)) {
  Copy-Item -Recurse -Force -LiteralPath (Join-Path $PresetSource $Preset) -Destination (Join-Path $RuntimeHome '.agent-presets')
}

$env:DSH_HOME = $RuntimeHome
$env:DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
node (Join-Path $SourceRoot 'apps\cli\lib\bin.js') web --host 127.0.0.1 --port $Port
