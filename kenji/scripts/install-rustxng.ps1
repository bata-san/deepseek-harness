# Install (or update) RustXNG for Windows from GitHub Releases with SHA-256 verification.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-rustxng.ps1 [-Tag v0.31.0]
param(
  [string]$Dest = 'C:\ProgramData\kenji\tools\rustxng',
  [string]$Repo = 'sahenjp/RustXNG',
  [string]$Tag = 'latest'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'kenji-harness-setup'; 'Accept' = 'application/vnd.github+json' }

$api = if ($Tag -eq 'latest') { "https://api.github.com/repos/$Repo/releases/latest" } else { "https://api.github.com/repos/$Repo/releases/tags/$Tag" }
$release = Invoke-RestMethod -Headers $headers $api
Write-Host "release: $($release.tag_name)"
$assets = $release.assets
$asset = $assets | Where-Object { $_.name -match '(?i)(windows|win64|pc-windows)' -and $_.name -match '(?i)(x86_64|amd64|x64)' -and $_.name -notmatch '(?i)\.(sha256|sig|asc|txt)$' } | Select-Object -First 1
if (-not $asset) {
  Write-Host ($assets | ForEach-Object { $_.name }) -Separator "`n"
  throw 'no Windows x86_64 asset found in the release'
}
Write-Host "asset: $($asset.name)"
$sumAsset = $assets | Where-Object { $_.name -eq "$($asset.name).sha256" } | Select-Object -First 1
if (-not $sumAsset) { $sumAsset = $assets | Where-Object { $_.name -match '(?i)(sha256sums|checksums)' } | Select-Object -First 1 }
if (-not $sumAsset) { throw 'no SHA-256 checksum asset found; refusing to install an unverified binary' }

$tmp = Join-Path $env:TEMP ("rustxng-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
$file = Join-Path $tmp $asset.name
Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'kenji-harness-setup' } -Uri $asset.browser_download_url -OutFile $file
$sumText = (Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'kenji-harness-setup' } -Uri $sumAsset.browser_download_url).Content
if ($sumText -is [byte[]]) { $sumText = [Text.Encoding]::UTF8.GetString($sumText) }
$expected = $null
foreach ($line in ($sumText -split "`n")) {
  $parts = $line.Trim() -split '\s+'
  if ($parts.Count -ge 1 -and $parts[0] -match '^[0-9a-fA-F]{64}$') {
    if ($parts.Count -eq 1 -or $parts[-1].TrimStart('*') -eq $asset.name) { $expected = $parts[0].ToLower(); break }
  }
}
if (-not $expected) { throw 'checksum for the asset not found in the checksum file' }
$actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 mismatch: expected $expected, got $actual" }
Write-Host "sha256 ok: $actual"

New-Item -ItemType Directory -Force $Dest | Out-Null
if ($asset.name -match '(?i)\.zip$') {
  $out = Join-Path $tmp 'x'
  Expand-Archive -Path $file -DestinationPath $out -Force
  $exe = Get-ChildItem -Recurse -Path $out -Filter 'rustxng*.exe' | Select-Object -First 1
  if (-not $exe) { throw 'rustxng.exe not found in the archive' }
  Copy-Item $exe.FullName (Join-Path $Dest 'rustxng.exe') -Force
} elseif ($asset.name -match '(?i)\.(tar\.gz|tgz)$') {
  $out = Join-Path $tmp 'x'
  New-Item -ItemType Directory -Force $out | Out-Null
  tar -xzf $file -C $out
  $exe = Get-ChildItem -Recurse -Path $out -Filter 'rustxng*.exe' | Select-Object -First 1
  if (-not $exe) { throw 'rustxng.exe not found in the archive' }
  Copy-Item $exe.FullName (Join-Path $Dest 'rustxng.exe') -Force
} else {
  Copy-Item $file (Join-Path $Dest 'rustxng.exe') -Force
}
Set-Content -Path (Join-Path $Dest 'VERSION') -Value "$($release.tag_name) $actual" -Encoding ASCII
Remove-Item -Recurse -Force $tmp
& (Join-Path $Dest 'rustxng.exe') --version
Write-Host 'RUSTXNG OK'
