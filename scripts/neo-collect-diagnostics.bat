@echo off
chcp 65001 >nul
echo Collecting Agent Neo diagnostics, please wait...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $i=$f.IndexOf('#PS'+'BEGIN'); Invoke-Expression $f.Substring($i)"
echo.
pause
exit /b

#PSBEGIN
# Agent Neo Windows 诊断收集脚本（给测试用户一键跑）
# 产出：桌面上一个 zip；只收日志/配置脱敏副本/系统信息，不收对话数据库、不收密钥
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$work   = Join-Path $env:TEMP "neo-diag-$stamp"
New-Item -ItemType Directory -Path $work -Force | Out-Null

$dataDir  = Join-Path $env:USERPROFILE '.code-agent'
$shellDir = Join-Path $env:APPDATA 'com.linchen.code-agent'
$cutoff   = (Get-Date).AddDays(-7)

function Copy-Recent($src, $dst) {
  if (-not (Test-Path $src)) { return }
  Get-ChildItem $src -File -Recurse | Where-Object { $_.LastWriteTime -gt $cutoff } | ForEach-Object {
    $rel    = $_.FullName.Substring($src.Length).TrimStart('\')
    $target = Join-Path $dst $rel
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item $_.FullName $target -Force
  }
}

Write-Host '[1/6] 收集应用日志...'
Copy-Recent (Join-Path $dataDir 'logs')  (Join-Path $work 'host-logs')
Copy-Recent (Join-Path $shellDir 'logs') (Join-Path $work 'shell-logs')
Copy-Recent (Join-Path $dataDir 'audit') (Join-Path $work 'audit')

Write-Host '[2/6] 收集配置（已脱敏，密钥一律抹掉）...'
$cfg = Join-Path $dataDir 'config.json'
if (Test-Path $cfg) {
  $text = Get-Content $cfg -Raw -Encoding UTF8
  $text = $text -replace '("[^"]*(?:key|token|secret|password|credential)[^"]*"\s*:\s*")[^"]*(")', '$1REDACTED$2'
  $text = $text -replace 'sk-[A-Za-z0-9_\-]{8,}', 'sk-REDACTED'
  Set-Content -Path (Join-Path $work 'config.redacted.json') -Value $text -Encoding UTF8
}

Write-Host '[3/6] 记录渲染缓存与崩溃转储清单（只记文件名，不拷内容）...'
$rc = Join-Path $dataDir 'renderer-cache'
if (Test-Path $rc) {
  Get-ChildItem $rc -Recurse | Select-Object FullName, Length, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300 |
    Set-Content -Path (Join-Path $work 'renderer-cache-listing.txt') -Encoding UTF8
}
$dumps = Join-Path $env:LOCALAPPDATA 'CrashDumps'
if (Test-Path $dumps) {
  Get-ChildItem $dumps | Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300 |
    Set-Content -Path (Join-Path $work 'crashdumps-listing.txt') -Encoding UTF8
}

Write-Host '[4/6] 收集系统与版本信息...'
$os   = Get-CimInstance Win32_OperatingSystem
$app  = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
        Where-Object { $_.DisplayName -like '*Agent Neo*' -or $_.DisplayName -like '*code-agent*' } |
        Select-Object -First 1
$wv2 = $null
foreach ($p in @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)) {
  $v = (Get-ItemProperty $p).pv
  if ($v) { $wv2 = $v; break }
}
$info = [ordered]@{
  collected_at     = (Get-Date).ToString('o')
  os               = "$($os.Caption) $($os.Version)"
  locale           = (Get-Culture).Name
  app_version      = $app.DisplayVersion
  app_install_path = $app.InstallLocation
  webview2_version = $wv2
  neo_processes    = @(Get-Process | Where-Object { $_.Name -match 'agent|neo|webview2' } |
                       Select-Object Name, Id, StartTime, CPU, WorkingSet64)
}
$info | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $work 'system-info.json') -Encoding UTF8

Write-Host '[5/6] 收集系统事件日志里的崩溃/挂起记录...'
Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $cutoff } -MaxEvents 2000 |
  Where-Object {
    $_.ProviderName -match 'Application Error|Application Hang|Windows Error Reporting' -and
    $_.Message -match 'neo|code.agent|webview2'
  } |
  Select-Object TimeCreated, Id, ProviderName, Message |
  Format-List | Out-String -Width 300 |
  Set-Content -Path (Join-Path $work 'windows-app-events.txt') -Encoding UTF8

Set-Content -Path (Join-Path $work 'README.txt') -Encoding UTF8 -Value @(
  'Agent Neo Windows diagnostics bundle',
  "Collected: $stamp",
  '',
  'Contents: app logs (7 days), shell boot diagnostics, audit trail,',
  'redacted config, renderer-cache/crash-dump listings, system info,',
  'Windows crash/hang events. No conversation database, no credentials.'
)

Write-Host '[6/6] 打包到桌面...'
$desktop = [Environment]::GetFolderPath('Desktop')
$zip     = Join-Path $desktop "Neo-diagnostics-$stamp.zip"
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
Remove-Item $work -Recurse -Force

Write-Host ''
if (Test-Path $zip) {
  Write-Host "完成！诊断包已生成在桌面：$zip"
  Write-Host '请把这个 zip 文件发给开发者（建议私聊发送）。'
} else {
  Write-Host '打包失败，请截图本窗口内容发给开发者。'
}
