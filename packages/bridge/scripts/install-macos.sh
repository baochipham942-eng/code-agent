#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STATE_DIR="${HOME}/.code-agent-bridge"
BIN_WRAPPER="/usr/local/bin/code-agent-bridge"
RUNTIME_FILE="${STATE_DIR}/code-agent-bridge.cjs"
PLIST="${HOME}/Library/LaunchAgents/com.code-agent.bridge.plist"

mkdir -p "${STATE_DIR}"
cp "${ROOT_DIR}/dist/bridge/code-agent-bridge.cjs" "${RUNTIME_FILE}"
chmod +x "${RUNTIME_FILE}"

sudo mkdir -p /usr/local/bin
sudo tee "${BIN_WRAPPER}" >/dev/null <<EOF
#!/usr/bin/env bash
exec node "${RUNTIME_FILE}" "\$@"
EOF
sudo chmod +x "${BIN_WRAPPER}"

cat >"${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.code-agent.bridge</string>
    <key>ProgramArguments</key>
    <array>
      <string>${BIN_WRAPPER}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${STATE_DIR}/bridge.log</string>
    <key>StandardErrorPath</key>
    <string>${STATE_DIR}/bridge.err.log</string>
  </dict>
</plist>
EOF

launchctl unload "${PLIST}" >/dev/null 2>&1 || true
launchctl load "${PLIST}"
echo "Installed code-agent-bridge"
