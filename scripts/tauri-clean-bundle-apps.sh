#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="${ROOT_DIR}/src-tauri/target/release/bundle"
TARGET_DIR="${ROOT_DIR}/src-tauri/target"
APP_NAME="${APP_NAME:-Agent Neo}"
LEGACY_APP_NAME="${LEGACY_APP_NAME:-Code Agent}"
HELPER_APP_NAME="${HELPER_APP_NAME:-Agent Neo Computer Use}"
DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-Install Agent Neo}"
INSTALLED_APP_PATH="${INSTALLED_APP_PATH:-/Applications/${APP_NAME}.app}"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

mark_target_unindexed() {
  mkdir -p "${TARGET_DIR}"
  touch "${TARGET_DIR}/.metadata_never_index" 2>/dev/null || true
}

unregister_app_path() {
  local app_path="$1"

  [[ -x "${LSREGISTER}" ]] || return 0
  "${LSREGISTER}" -u "${app_path}" >/dev/null 2>&1 || true
}

unregister_duplicate_app_entries() {
  [[ -x "${LSREGISTER}" ]] || return 0

  "${LSREGISTER}" -dump 2>/dev/null \
    | awk -F'path:[[:space:]]*' '/path:.*(Agent Neo Computer Use|Agent Neo|Code Agent)\.app/ { print $2 }' \
    | sed -E 's/ \([^)]*\)$//' \
    | while IFS= read -r app_path; do
        [[ -n "${app_path}" ]] || continue
        [[ "${app_path}" == "${INSTALLED_APP_PATH}" ]] && continue
        unregister_app_path "${app_path}"
      done
}

remove_generated_helper_apps() {
  [[ -d "${TARGET_DIR}" ]] || return 0

  while IFS= read -r app_path; do
    [[ -n "${app_path}" ]] || continue
    unregister_app_path "${app_path}"
    rm -rf "${app_path}"
  done < <(find "${TARGET_DIR}" -path "*/_up_/scripts/${HELPER_APP_NAME}.app" -type d -prune -print 2>/dev/null)
}

detach_bundle_volumes() {
  local mounted_name
  shopt -s nullglob

  for mounted_name in "${DMG_VOLUME_NAME}" "${APP_NAME}" "${LEGACY_APP_NAME}"; do
    for vol in /Volumes/"${mounted_name}"*; do
      [[ -d "${vol}" ]] && hdiutil detach "${vol}" >/dev/null 2>&1 || true
    done
  done

  for vol in /Volumes/dmg.*; do
    [[ -d "${vol}" ]] && hdiutil detach "${vol}" >/dev/null 2>&1 || true
  done
}

remove_bundle_app() {
  local app_path="$1"

  [[ -d "${app_path}" ]] || return 0
  unregister_app_path "${app_path}"
  rm -rf "${app_path}"
}

mark_target_unindexed
remove_generated_helper_apps

if [[ -d "${BUNDLE_DIR}" ]]; then
  find "${BUNDLE_DIR}" -type f -name 'rw.*.dmg' -delete 2>/dev/null || true

  shopt -s nullglob
  for app_path in \
    "${BUNDLE_DIR}/macos/${APP_NAME}.app" \
    "${BUNDLE_DIR}/macos/${LEGACY_APP_NAME}.app" \
    "${ROOT_DIR}"/release/*/"${APP_NAME}.app" \
    "${ROOT_DIR}"/release/*/"${LEGACY_APP_NAME}.app"; do
    remove_bundle_app "${app_path}"
  done
fi

detach_bundle_volumes
unregister_duplicate_app_entries

echo "[tauri-clean-bundle-apps] cleaned temporary app bundles"
