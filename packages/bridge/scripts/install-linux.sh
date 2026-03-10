#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STATE_DIR="${HOME}/.code-agent-bridge"
BIN_WRAPPER="${HOME}/.local/bin/code-agent-bridge"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/code-agent-bridge.service"

mkdir -p "${STATE_DIR}" "$(dirname "${BIN_WRAPPER}")" "${SERVICE_DIR}"
cp "${ROOT_DIR}/dist/bridge/code-agent-bridge.cjs" "${STATE_DIR}/code-agent-bridge.cjs"

cat >"${BIN_WRAPPER}" <<EOF
#!/usr/bin/env bash
exec node "${STATE_DIR}/code-agent-bridge.cjs" "\$@"
EOF
chmod +x "${BIN_WRAPPER}"

cat >"${SERVICE_FILE}" <<EOF
[Unit]
Description=Code Agent Bridge

[Service]
ExecStart=${BIN_WRAPPER}
Restart=always

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now code-agent-bridge.service
echo "Installed code-agent-bridge"
