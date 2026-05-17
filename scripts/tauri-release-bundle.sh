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

REQUIRE_CONTROL_PLANE_PUBLIC_KEYS="${REQUIRE_CONTROL_PLANE_PUBLIC_KEYS:-1}"
REQUIRE_DEVELOPER_ID="${REQUIRE_DEVELOPER_ID:-${REQUIRE_NOTARIZATION:-0}}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-${TAURI_MACOS_SIGNING_IDENTITY:-}}"

if [[ "${REQUIRE_DEVELOPER_ID}" == "1" || "${REQUIRE_DEVELOPER_ID}" == "true" ]]; then
  if [[ -z "${SIGNING_IDENTITY}" ]]; then
    echo "APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY is required for Developer ID release builds" >&2
    exit 1
  fi
  if [[ "${SIGNING_IDENTITY}" != Developer\ ID\ Application:* ]]; then
    echo "macOS release signing identity must be a Developer ID Application identity" >&2
    echo "Current identity: ${SIGNING_IDENTITY}" >&2
    exit 1
  fi
fi

if [[ "${REQUIRE_CONTROL_PLANE_PUBLIC_KEYS}" == "1" || "${REQUIRE_CONTROL_PLANE_PUBLIC_KEYS}" == "true" ]]; then
  HAS_CONTROL_PLANE_PUBLIC_KEYS=0
  if [[ -n "${CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS:-}" || -n "${CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE:-}" ]]; then
    HAS_CONTROL_PLANE_PUBLIC_KEYS=1
  fi
  if [[ -n "${CODE_AGENT_CONTROL_PLANE_KEY_ID:-}" && -n "${CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY:-}" ]]; then
    HAS_CONTROL_PLANE_PUBLIC_KEYS=1
  fi
  if [[ "${HAS_CONTROL_PLANE_PUBLIC_KEYS}" == "0" ]]; then
    echo "CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS or CODE_AGENT_CONTROL_PLANE_KEY_ID + CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY is required for release builds" >&2
    exit 1
  fi
fi

if [[ -z "${APPLE_PASSWORD:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  export APPLE_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD}"
fi

if [[ "${REQUIRE_NOTARIZATION:-0}" == "1" || "${REQUIRE_NOTARIZATION:-0}" == "true" ]]; then
  HAS_APPLE_ID_AUTH=0
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    HAS_APPLE_ID_AUTH=1
  fi

  HAS_APPLE_API_AUTH=0
  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
    HAS_APPLE_API_AUTH=1
  fi

  if [[ "${HAS_APPLE_ID_AUTH}" == "0" && "${HAS_APPLE_API_AUTH}" == "0" ]]; then
    echo "Notarization is required, but Apple notarization credentials are incomplete" >&2
    echo "Set APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH" >&2
    exit 1
  fi
fi

REPOSITORY="${GITHUB_REPOSITORY:-baochipham942-eng/code-agent}"
UPDATER_ENDPOINT="${TAURI_UPDATER_ENDPOINT:-https://github.com/${REPOSITORY}/releases/latest/download/latest.json}"

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
