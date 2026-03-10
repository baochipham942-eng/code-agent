#!/usr/bin/env bash
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/com.code-agent.bridge.plist"

launchctl unload "${PLIST}" >/dev/null 2>&1 || true
rm -f "${PLIST}"
sudo rm -f /usr/local/bin/code-agent-bridge
rm -rf "${HOME}/.code-agent-bridge"
echo "Uninstalled code-agent-bridge"
