#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"

CUA_APP_NAME="Agent Neo Computer Use"
CUA_BUNDLE_ID="com.agentneo.computeruse"
STAGING_ROOT="${ROOT_DIR}/.tauri-resources.noindex"
STAGED_APP="${STAGING_ROOT}/scripts/${CUA_APP_NAME}.app"
LEGACY_APP="${SCRIPT_DIR}/${CUA_APP_NAME}.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[stage-cua-driver-resource] skipped: cua-driver app bundle is macOS-only"
  exit 0
fi

unregister_app_path() {
  local app_path="$1"
  [[ -x "${LSREGISTER}" ]] || return 0
  "${LSREGISTER}" -u "${app_path}" >/dev/null 2>&1 || true
}

app_ready() {
  local app_path="$1"
  [[ -d "${app_path}" ]] || return 1
  [[ -x "${app_path}/Contents/MacOS/cua-driver" ]] || return 1

  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${app_path}/Contents/Info.plist" 2>/dev/null)" || return 1
  [[ "${bundle_id}" == "${CUA_BUNDLE_ID}" ]] || return 1

  codesign --verify --strict "${app_path}" >/dev/null 2>&1
}

ensure_staging_root() {
  mkdir -p "${STAGING_ROOT}/scripts"
  touch "${STAGING_ROOT}/.metadata_never_index" 2>/dev/null || true
}

remove_legacy_app() {
  [[ -d "${LEGACY_APP}" ]] || return 0
  unregister_app_path "${LEGACY_APP}"
  rm -rf "${LEGACY_APP}"
}

ensure_staging_root

if app_ready "${STAGED_APP}"; then
  remove_legacy_app
  echo "[stage-cua-driver-resource] staged helper ready: ${STAGED_APP}"
  exit 0
fi

if app_ready "${LEGACY_APP}"; then
  rm -rf "${STAGED_APP}"
  ditto --noqtn "${LEGACY_APP}" "${STAGED_APP}"
  if ! app_ready "${STAGED_APP}"; then
    echo "[stage-cua-driver-resource] staged helper failed validation after legacy migration" >&2
    exit 1
  fi
  remove_legacy_app
  echo "[stage-cua-driver-resource] migrated legacy helper into noindex staging: ${STAGED_APP}"
  exit 0
fi

cat >&2 <<EOF
[stage-cua-driver-resource] missing staged ${CUA_APP_NAME}.app
Run one of:
  CUA_FETCH_PREBUILT=1 bash scripts/fetch-cua-driver.sh
  bash scripts/fetch-cua-driver.sh
EOF
exit 1
