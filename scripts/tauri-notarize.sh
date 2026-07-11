#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Agent Neo}"
APP_PATH="${APP_PATH:-${ROOT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}.app}"
DMG_DIR="${DMG_DIR:-${ROOT_DIR}/src-tauri/target/release/bundle/dmg}"
REQUIRE_NOTARIZATION="${REQUIRE_NOTARIZATION:-0}"
NOTARYTOOL_WAIT_TIMEOUT="${NOTARYTOOL_WAIT_TIMEOUT:-30m}"
NOTARYTOOL_NO_S3_ACCELERATION="${NOTARYTOOL_NO_S3_ACCELERATION:-1}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-${TAURI_MACOS_SIGNING_IDENTITY:-}}"

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

submit_dmg() {
  local dmg_path="$1"
  echo "[tauri-notarize] submitting dmg: ${dmg_path}"
  submit_args=(submit "${dmg_path}" "${NOTARY_ARGS[@]}" --wait --timeout "${NOTARYTOOL_WAIT_TIMEOUT}")
  if [[ "${NOTARYTOOL_NO_S3_ACCELERATION}" == "1" || "${NOTARYTOOL_NO_S3_ACCELERATION}" == "true" ]]; then
    submit_args+=(--no-s3-acceleration)
  fi
  xcrun notarytool "${submit_args[@]}"
}

staple_and_validate_dmg() {
  local dmg_path="$1"

  echo "[tauri-notarize] stapling dmg: ${dmg_path}"
  xcrun stapler staple "${dmg_path}"
  xcrun stapler validate "${dmg_path}"
}

rebuild_dmg_with_stapled_app() {
  local dmg_path="$1"
  local app_path="$2"
  local app_name
  local mountpoint
  local rw_base
  local rw_dmg
  local rebuilt_base
  local rebuilt_dmg
  local mounted=0

  if [[ -z "${SIGNING_IDENTITY}" ]]; then
    echo "[tauri-notarize] APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY is required to rebuild the notarized dmg" >&2
    exit 1
  fi

  app_name="$(basename "${app_path}")"
  mountpoint="$(mktemp -d "${TMPDIR:-/tmp}/agent-neo-notarized-dmg-mount.XXXXXX")"
  rw_base="$(mktemp -u "${TMPDIR:-/tmp}/agent-neo-notarized-dmg-rw.XXXXXX")"
  rebuilt_base="$(mktemp -u "${TMPDIR:-/tmp}/agent-neo-notarized-dmg-final.XXXXXX")"
  rw_dmg="${rw_base}.dmg"
  rebuilt_dmg="${rebuilt_base}.dmg"

  cleanup_rebuilt_dmg() {
    if [[ "${mounted}" == "1" ]]; then
      hdiutil detach "${mountpoint}" -quiet >/dev/null 2>&1 \
        || hdiutil detach "${mountpoint}" -force -quiet >/dev/null 2>&1 \
        || true
    fi
    rm -rf "${mountpoint}"
    rm -f "${rw_dmg}" "${rebuilt_dmg}"
  }
  trap cleanup_rebuilt_dmg RETURN

  echo "[tauri-notarize] rebuilding dmg with stapled app: ${dmg_path}"
  hdiutil convert "${dmg_path}" -format UDRW -o "${rw_base}" >/dev/null
  hdiutil attach "${rw_dmg}" \
    -readwrite \
    -nobrowse \
    -noautoopen \
    -mountpoint "${mountpoint}" \
    >/dev/null
  mounted=1

  rm -rf "${mountpoint:?}/${app_name}"
  ditto "${app_path}" "${mountpoint}/${app_name}"
  sync

  hdiutil detach "${mountpoint}" -quiet >/dev/null \
    || hdiutil detach "${mountpoint}" -force -quiet >/dev/null
  mounted=0

  hdiutil convert "${rw_dmg}" -format UDZO -o "${rebuilt_base}" >/dev/null
  mv "${rebuilt_dmg}" "${dmg_path}"
  codesign --force --timestamp --sign "${SIGNING_IDENTITY}" "${dmg_path}"
  codesign --verify --strict --verbose=2 "${dmg_path}"

  trap - RETURN
  cleanup_rebuilt_dmg
}

# First submission registers the nested app with Apple's notary service. The app
# ticket is not available until that submission is accepted.
for dmg_path in "${dmg_files[@]}"; do
  submit_dmg "${dmg_path}"
done

if [[ -d "${APP_PATH}" ]]; then
  # tauri-bundler 在 notarize-dmg 之前就 finalize 了 dmg 里的 .app，
  # 所以 dmg 外壳有 ticket 但 .app 自身没有。这里单独 staple 一刀，
  # 让 .app 也能离线启动 / Tauri auto-update 解包后能过 Gatekeeper。
  echo "[tauri-notarize] stapling app: ${APP_PATH}"
  xcrun stapler staple "${APP_PATH}"
  xcrun stapler validate "${APP_PATH}"

  # The original dmg was finalized before the app ticket existed. Replace its
  # nested app with the stapled copy, then re-sign and notarize the final bytes.
  # This keeps fresh DMG installs offline-launchable instead of depending on a
  # slow or unavailable Gatekeeper ticket lookup during first boot.
  for dmg_path in "${dmg_files[@]}"; do
    rebuild_dmg_with_stapled_app "${dmg_path}" "${APP_PATH}"
    submit_dmg "${dmg_path}"
    staple_and_validate_dmg "${dmg_path}"
  done
else
  for dmg_path in "${dmg_files[@]}"; do
    staple_and_validate_dmg "${dmg_path}"
  done
fi

echo "[tauri-notarize] passed"
