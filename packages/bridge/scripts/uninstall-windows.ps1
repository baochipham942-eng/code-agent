$ErrorActionPreference = "SilentlyContinue"
$Startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
Remove-Item (Join-Path $Startup "Code Agent Bridge.lnk") -Force
Remove-Item (Join-Path $HOME ".code-agent-bridge") -Recurse -Force
Write-Host "Uninstalled code-agent-bridge"
