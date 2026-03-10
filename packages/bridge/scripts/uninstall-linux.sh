#!/usr/bin/env bash
set -euo pipefail

systemctl --user disable --now code-agent-bridge.service >/dev/null 2>&1 || true
rm -f "${HOME}/.config/systemd/user/code-agent-bridge.service"
systemctl --user daemon-reload
rm -f "${HOME}/.local/bin/code-agent-bridge"
rm -rf "${HOME}/.code-agent-bridge"
echo "Uninstalled code-agent-bridge"
