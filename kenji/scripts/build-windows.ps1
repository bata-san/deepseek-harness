# Kenji Harness: fetch and build on Windows.
# Meant to run as a Kenji job (SYSTEM or the service account).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-windows.ps1 [-Branch kenji-clean] [-SkipCore] [-IfChanged]
# -IfChanged: exit early when the remote branch has no new commit (used by the scheduled auto-update job).
# Re-applies <Root>\purge.ps1 apply when that local file exists.
# After a successful build the script touches <Root>\restart-request; the gateway restarts the harness
# when no session is running.
param(
  [string]$Root = 'C:\ProgramData\kenji\harness',
  [string]$Repo = 'https://github.com/bata-san/deepseek-harness',
  [string]$Branch = 'kenji-clean',
  [switch]$SkipCore,
  [switch]$IfChanged
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$src = Join-Path $Root 'src'
$bin = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force $Root, $bin | Out-Null
$env:PATH = "C:\ProgramData\kenji\tools\mingit\cmd;$bin;$env:PATH"
$env:COREPACK_HOME = Join-Path $Root 'corepack'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:npm_config_store_dir = Join-Path $Root 'pnpm-store'
$env:CI = '1'

function Step($name, [scriptblock]$block) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Write-Host "==> $name"
  & $block
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "$name failed (exit $LASTEXITCODE)" }
  Write-Host ("<== {0} ({1:n0}s)" -f $name, $sw.Elapsed.TotalSeconds)
}

git config --global core.longpaths true
if ($IfChanged -and (Test-Path (Join-Path $src '.git'))) {
  git -C $src fetch --depth 1 origin $Branch
  $local = (git -C $src rev-parse HEAD).Trim()
  $remote = (git -C $src rev-parse FETCH_HEAD).Trim()
  if ($local -eq $remote) { Write-Host "up to date: $local"; exit 0 }
  Write-Host "update available: $local -> $remote"
}

Step 'git checkout' {
  if (-not (Test-Path (Join-Path $src '.git'))) {
    git clone --depth 1 --branch $Branch $Repo $src
  } else {
    git -C $src fetch --depth 1 origin $Branch
    git -C $src reset --hard FETCH_HEAD
  }
  git -C $src log -1 --format='%h %s'
  # Keep the scheduled entry point in sync with the checked-out script.
  Copy-Item (Join-Path $src 'kenji\scripts\build-windows.ps1') (Join-Path $Root 'build.ps1') -Force
}

Step 'corepack pnpm' {
  corepack enable --install-directory $bin
  pnpm --version
}

Set-Location $src
if (-not $SkipCore) {
  Step 'pnpm install' { pnpm install --frozen-lockfile }
  Step 'build artifacts' { pnpm run build:artifacts }
}

# Optional local hook: re-apply the dsh-purge patches that a rebuild overwrites.
# <Root>\purge.ps1 is machine-local (it sets DSH_HOME / PURGE_DSH_CLI); skipped when absent.
$purge = Join-Path $Root 'purge.ps1'
if (-not $SkipCore -and (Test-Path $purge)) {
  try {
    Write-Host '==> purge apply'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $purge apply | Out-Host
  } catch {
    Write-Host ('purge apply failed (build continues): ' + $_.Exception.Message)
  }
}

Set-Content -Path (Join-Path $Root 'restart-request') -Value (git -C $src rev-parse HEAD).Trim() -Encoding ASCII
Write-Host 'BUILD OK'
