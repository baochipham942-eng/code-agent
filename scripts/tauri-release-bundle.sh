#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${ROOT_DIR}/.tauri-release"
CONFIG_FILE="${CONFIG_DIR}/tauri.updater.conf.json"

UPDATER_PUBKEY="${TAURI_UPDATER_PUBKEY:-}"
if [[ -z "${UPDATER_PUBKEY}" && -n "${TAURI_UPDATER_PUBKEY_PATH:-}" ]]; then
  UPDATER_PUBKEY="$(tr -d '\n' < "${TAURI_UPDATER_PUBKEY_PATH}")"
fi

if [[ -z "${UPDATER_PUBKEY}" ]]; then
  echo "TAURI_UPDATER_PUBKEY or TAURI_UPDATER_PUBKEY_PATH is required for release updater builds" >&2
  exit 1
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required to create updater signatures" >&2
  exit 1
fi

REPOSITORY="${GITHUB_REPOSITORY:-baochipham942-eng/code-agent}"
UPDATER_ENDPOINT="${TAURI_UPDATER_ENDPOINT:-https://github.com/${REPOSITORY}/releases/latest/download/latest.json}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-${TAURI_MACOS_SIGNING_IDENTITY:-}}"

mkdir -p "${CONFIG_DIR}"

node -e '
const fs = require("node:fs");
const [configFile, endpoint, pubkey, signingIdentity] = process.argv.slice(1);
const bundle = { createUpdaterArtifacts: true };
if (signingIdentity) {
  bundle.macOS = { signingIdentity };
}
fs.writeFileSync(configFile, JSON.stringify({
  bundle,
  plugins: {
    updater: {
      endpoints: [endpoint],
      pubkey,
    },
  },
}, null, 2));
' "${CONFIG_FILE}" "${UPDATER_ENDPOINT}" "${UPDATER_PUBKEY}" "${SIGNING_IDENTITY}"

cd "${ROOT_DIR}"
cargo tauri build --config "${CONFIG_FILE}" --ci "$@"

for app_path in "${ROOT_DIR}"/src-tauri/target/release/bundle/macos/*.app; do
  [[ -d "${app_path}" ]] || continue
  node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${app_path}/Contents/Resources/_up_"
done
