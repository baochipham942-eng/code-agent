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

node "${ROOT_DIR}/scripts/prepare-bundled-node.mjs"

# Run cargo tauri build in a subshell with Apple notarization env vars unset.
# Tauri auto-triggers notarytool inside `cargo tauri build` when it sees these
# variables, but we must sign nested Mach-O binaries (.node/.dylib + helper
# executables that ship under Contents/Resources/_up_/) BEFORE notarization,
# otherwise Apple rejects the submission. The unset is inside a subshell so the
# parent env stays intact for the downstream `release:notarize-macos` step.
(
  unset APPLE_ID APPLE_PASSWORD APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
  cargo tauri build --config "${CONFIG_FILE}" --ci "$@"
)

# Post-build: sign nested macOS Mach-O binaries that Tauri did not touch, then
# re-sign the .app shell and rebuild + sign the .dmg so hashes stay consistent.
if [[ "$(uname -s)" == "Darwin" && -n "${SIGNING_IDENTITY}" ]]; then
  ENTITLEMENTS_PATH="${ROOT_DIR}/src-tauri/Entitlements.plist"
  if [[ ! -f "${ENTITLEMENTS_PATH}" ]]; then
    echo "Missing entitlements file at ${ENTITLEMENTS_PATH}" >&2
    exit 1
  fi

  sign_nested_binary() {
    local target="$1"
    local use_entitlements="$2"

    # Skip non-darwin .node files (PE32 win32 / ELF linux prebuilds also ship).
    if ! file "${target}" 2>/dev/null | grep -q "Mach-O"; then
      return 0
    fi

    # Skip files already signed with a Developer ID Application certificate
    # (avoids re-signing Tauri's own outputs and the Rust binary).
    if codesign -dvv "${target}" 2>&1 | grep -q "Authority=Developer ID Application:"; then
      return 0
    fi

    local args=(--force --options runtime --timestamp --sign "${SIGNING_IDENTITY}")
    if [[ "${use_entitlements}" == "1" ]]; then
      args+=(--entitlements "${ENTITLEMENTS_PATH}")
    fi
    echo "  signing ${target}"
    codesign "${args[@]}" "${target}"
  }

  for app_path in "${ROOT_DIR}"/src-tauri/target/release/bundle/macos/*.app; do
    [[ -d "${app_path}" ]] || continue
    node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${app_path}/Contents/Resources/_up_"

    echo "[tauri-release-bundle] signing nested Mach-O binaries inside ${app_path}"

    # Pass 1: libraries and native node addons (no entitlements needed).
    while IFS= read -r -d '' nested; do
      sign_nested_binary "${nested}" "0"
    done < <(find "${app_path}" \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) -type f -print0)

    # Pass 2: standalone executable helpers (need entitlements + hardened runtime).
    # Enumerated by basename - these are the helpers known to ship unsigned.
    while IFS= read -r -d '' nested; do
      sign_nested_binary "${nested}" "1"
    done < <(find "${app_path}" -type f \( -name "system-audio-capture" -o -name "spawn-helper" -o -name "vision-tagger" -o -name "vision-ocr" -o -path "*/dist/bundled-node/bin/node" \) -print0)

    echo "[tauri-release-bundle] re-signing .app shell: ${app_path}"
    codesign --force --options runtime --timestamp \
      --entitlements "${ENTITLEMENTS_PATH}" \
      --sign "${SIGNING_IDENTITY}" "${app_path}"
    codesign --verify --deep --strict --verbose=2 "${app_path}"
  done

  # Rebuild the .dmg from the freshly-signed .app so its contents match.
  DMG_DIR="${ROOT_DIR}/src-tauri/target/release/bundle/dmg"
  if [[ -d "${DMG_DIR}" ]]; then
    shopt -s nullglob
    APP_BUNDLES=("${ROOT_DIR}"/src-tauri/target/release/bundle/macos/*.app)
    if (( ${#APP_BUNDLES[@]} > 0 )); then
      APP_BUNDLE="${APP_BUNDLES[0]}"
      VOLNAME="$(basename "${APP_BUNDLE}" .app)"
      OLD_DMGS=("${DMG_DIR}"/*.dmg)
      DMG_BASENAME=""
      if (( ${#OLD_DMGS[@]} > 0 )); then
        DMG_BASENAME="$(basename "${OLD_DMGS[0]}")"
        for old in "${OLD_DMGS[@]}"; do
          echo "[tauri-release-bundle] removing stale dmg: ${old}"
          rm -f "${old}"
        done
      fi
      if [[ -z "${DMG_BASENAME}" ]]; then
        DMG_BASENAME="${VOLNAME}.dmg"
      fi
      DMG_PATH="${DMG_DIR}/${DMG_BASENAME}"
      echo "[tauri-release-bundle] rebuilding dmg: ${DMG_PATH}"
      hdiutil create -volname "${VOLNAME}" -srcfolder "${APP_BUNDLE}" -ov -format UDZO "${DMG_PATH}"
      echo "[tauri-release-bundle] signing dmg: ${DMG_PATH}"
      codesign --force --timestamp --sign "${SIGNING_IDENTITY}" "${DMG_PATH}"
    fi
    shopt -u nullglob
  fi
else
  # Non-Darwin or no signing identity (REQUIRE_DEVELOPER_ID=0): just run the
  # release security scan without touching signatures.
  for app_path in "${ROOT_DIR}"/src-tauri/target/release/bundle/macos/*.app; do
    [[ -d "${app_path}" ]] || continue
    node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${app_path}/Contents/Resources/_up_"
  done
fi
