# Kenji Harness: Windows 上での取得・ビルド
# Kenji のジョブとして実行する想定（SYSTEM / サービスアカウント権限）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-windows.ps1 [-Branch kenji-clean] [-SkipCore]
param(
  [string]$Root = 'C:\ProgramData\kenji\harness',
  [string]$Repo = 'https://github.com/bata-san/deepseek-harness',
  [string]$Branch = 'kenji-clean',
  [switch]$SkipCore
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

Step 'git checkout' {
  git config --global core.longpaths true
  if (-not (Test-Path (Join-Path $src '.git'))) {
    git clone --depth 1 --branch $Branch $Repo $src
  } else {
    git -C $src fetch --depth 1 origin $Branch
    git -C $src reset --hard FETCH_HEAD
  }
  git -C $src log -1 --format='%h %s'
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

$mobile = Join-Path $src 'kenji\mobile'
if (Test-Path (Join-Path $mobile 'package.json')) {
  Set-Location $mobile
  Step 'mobile install' { npm ci --no-audit --no-fund }
  Step 'mobile build' { npm run build }
}
Write-Host 'BUILD OK'
