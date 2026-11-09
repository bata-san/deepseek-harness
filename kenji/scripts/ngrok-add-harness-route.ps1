# 既存の ngrok エンドポイント（Kenji）に /harness へのパス振り分けを追加する。
# ngrok サービスを再起動するため、Kenji のジョブとして実行する（接続が一時的に切れても完走する）。
# 公開 URL のヘルスチェックに失敗した場合は、元の設定へ自動で戻す。
param(
  [string]$Config = 'C:\ProgramData\kenji\ngrok-service.yml',
  [string]$Ngrok = 'C:\ProgramData\kenji\bin\ngrok.exe',
  [string]$Service = 'ngrok',
  [string]$PathPrefix = '/harness',
  [int]$GatewayPort = 3090
)
$ErrorActionPreference = 'Stop'

$text = [IO.File]::ReadAllText($Config)
if ($text -match 'harness\.internal') { Write-Host 'route already configured'; exit 0 }
$m = [regex]::Match($text, '(?m)^\s*url:\s*(https://\S+\.ngrok[-\w.]*)\s*$')
if (-not $m.Success) { throw 'public endpoint url not found in ngrok config' }
$public = $m.Groups[1].Value

$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$policy = @(
  '    traffic_policy:',
  '      on_http_request:',
  '        - expressions:',
  "            - ""req.url.path == '$PathPrefix' || req.url.path.startsWith('$PathPrefix/')""",
  '          actions:',
  '            - type: forward-internal',
  '              config:',
  '                url: https://harness.internal',
  '    upstream:'
) -join $nl
$pattern = '(?m)^    upstream:\s*$'
if (-not [regex]::IsMatch($text, $pattern)) { throw 'upstream block not found' }
$updated = [regex]::new($pattern).Replace($text, $policy, 1)
$updated = $updated.TrimEnd() + $nl + (@(
  '  - name: harness',
  '    url: https://harness.internal',
  '    upstream:',
  "      url: http://127.0.0.1:$GatewayPort"
) -join $nl) + $nl

$backup = "$Config.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $Config $backup
[IO.File]::WriteAllText($Config, $updated)
Write-Host "backup: $backup"

& $Ngrok config check --config $Config
if ($LASTEXITCODE -ne 0) {
  Copy-Item $backup $Config -Force
  throw 'ngrok config check failed; restored backup'
}

function Test-Public($path) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers @{ 'ngrok-skip-browser-warning' = '1' } "$public$path"
    return $r.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
}

Restart-Service $Service
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  $kenji = Test-Public '/api/health'
  $harness = Test-Public "$PathPrefix/healthz"
  Write-Host "check $i : kenji=$kenji harness=$harness"
  if ($kenji -eq 200 -and $harness -eq 200) { $ok = $true; break }
}
if (-not $ok) {
  Write-Host 'health check failed; rolling back'
  Copy-Item $backup $Config -Force
  Restart-Service $Service
  Start-Sleep -Seconds 8
  Write-Host ("after rollback: kenji=" + (Test-Public '/api/health'))
  exit 1
}
Write-Host "ROUTE OK: $public$PathPrefix/"
