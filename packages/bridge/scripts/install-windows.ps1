$ErrorActionPreference = "Stop"
$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$StateDir = Join-Path $HOME ".code-agent-bridge"
$BinFile = Join-Path $StateDir "code-agent-bridge.cjs"
$CmdFile = Join-Path $StateDir "code-agent-bridge.cmd"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
Copy-Item (Join-Path $RootDir "dist\bridge\code-agent-bridge.cjs") $BinFile -Force

@"
@echo off
node "$BinFile" %*
"@ | Set-Content -Path $CmdFile -Encoding ASCII

$Startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$ShortcutPath = Join-Path $Startup "Code Agent Bridge.lnk"
$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $CmdFile
$Shortcut.WorkingDirectory = $StateDir
$Shortcut.Save()

Write-Host "Installed code-agent-bridge"
