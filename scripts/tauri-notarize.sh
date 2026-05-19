#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Agent Neo}"
APP_PATH="${APP_PATH:-${ROOT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}.app}"
DMG_DIR="${DMG_DIR:-${ROOT_DIR}/src-tauri/target/release/bundle/dmg}"
REQUIRE_NOTARIZATION="${REQUIRE_NOTARIZATION:-0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[tauri-notarize] skipped: macOS notarization requires Darwin"
  exit 0
fi

if [[ -z "${APPLE_PASSWORD:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  export APPLE_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD}"
fi

if [[ "${REQUIRE_NOTARIZATION}" != "1" && "${REQUIRE_NOTARIZATION}" != "true" ]]; then
  echo "[tauri-notarize] skipped: REQUIRE_NOTARIZATION is not enabled"
  exit 0
fi

NOTARY_ARGS=()
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARY_ARGS=(--apple-id "${APPLE_ID}" --password "${APPLE_PASSWORD}" --team-id "${APPLE_TEAM_ID}")
elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  NOTARY_ARGS=(--key-id "${APPLE_API_KEY}" --issuer "${APPLE_API_ISSUER}" --key "${APPLE_API_KEY_PATH}")
else
  echo "[tauri-notarize] Apple notarization credentials are incomplete" >&2
  echo "Set APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH" >&2
  exit 1
fi

shopt -s nullglob
dmg_files=("${DMG_DIR}"/*.dmg)
if (( ${#dmg_files[@]} == 0 )); then
  echo "[tauri-notarize] missing dmg under ${DMG_DIR}" >&2
  exit 1
fi

for dmg_path in "${dmg_files[@]}"; do
  echo "[tauri-notarize] submitting dmg: ${dmg_path}"
  xcrun notarytool submit "${dmg_path}" "${NOTARY_ARGS[@]}" --wait

  echo "[tauri-notarize] stapling dmg: ${dmg_path}"
  xcrun stapler staple "${dmg_path}"
  xcrun stapler validate "${dmg_path}"
done

if [[ -d "${APP_PATH}" ]]; then
  # tauri-bundler 在 notarize-dmg 之前就 finalize 了 dmg 里的 .app，
  # 所以 dmg 外壳有 ticket 但 .app 自身没有。这里单独 staple 一刀，
  # 让 .app 也能离线启动 / Tauri auto-update 解包后能过 Gatekeeper。
  echo "[tauri-notarize] stapling app: ${APP_PATH}"
  xcrun stapler staple "${APP_PATH}"
  xcrun stapler validate "${APP_PATH}"
fi

echo "[tauri-notarize] passed"
