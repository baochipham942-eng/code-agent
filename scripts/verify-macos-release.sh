#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Agent Neo}"
APP_PATH="${APP_PATH:-${ROOT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}.app}"
DMG_DIR="${DMG_DIR:-${ROOT_DIR}/src-tauri/target/release/bundle/dmg}"
REQUIRE_NOTARIZATION="${REQUIRE_NOTARIZATION:-0}"
REQUIRE_DEVELOPER_ID="${REQUIRE_DEVELOPER_ID:-${REQUIRE_NOTARIZATION}}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[verify-macos-release] skipped: macOS release verification requires Darwin"
  exit 0
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "[verify-macos-release] missing app bundle: ${APP_PATH}" >&2
  exit 1
fi

RESOURCES_ROOT="${APP_PATH}/Contents/Resources/_up_"
if [[ ! -d "${RESOURCES_ROOT}" ]]; then
  echo "[verify-macos-release] missing bundled resources: ${RESOURCES_ROOT}" >&2
  exit 1
fi

echo "[verify-macos-release] scanning bundled resources"
node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${RESOURCES_ROOT}"

echo "[verify-macos-release] verifying app signature"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

if [[ "${REQUIRE_DEVELOPER_ID}" == "1" || "${REQUIRE_DEVELOPER_ID}" == "true" ]]; then
  app_signature="$(codesign -dv --verbose=4 "${APP_PATH}" 2>&1)"
  if ! grep -q '^Authority=Developer ID Application:' <<<"${app_signature}"; then
    echo "[verify-macos-release] app is not signed with a Developer ID Application identity" >&2
    echo "${app_signature}" >&2
    exit 1
  fi
  if grep -q '^TeamIdentifier=not set$' <<<"${app_signature}"; then
    echo "[verify-macos-release] app signature is missing TeamIdentifier" >&2
    echo "${app_signature}" >&2
    exit 1
  fi
fi

shopt -s nullglob
dmg_files=("${DMG_DIR}"/*.dmg)
if (( ${#dmg_files[@]} == 0 )); then
  echo "[verify-macos-release] missing dmg under ${DMG_DIR}" >&2
  exit 1
fi

for dmg_path in "${dmg_files[@]}"; do
  echo "[verify-macos-release] verifying dmg signature: ${dmg_path}"
  codesign --verify --verbose=2 "${dmg_path}"
  if [[ "${REQUIRE_DEVELOPER_ID}" == "1" || "${REQUIRE_DEVELOPER_ID}" == "true" ]]; then
    dmg_signature="$(codesign -dv --verbose=4 "${dmg_path}" 2>&1)"
    if ! grep -q '^Authority=Developer ID Application:' <<<"${dmg_signature}"; then
      echo "[verify-macos-release] dmg is not signed with a Developer ID Application identity: ${dmg_path}" >&2
      echo "${dmg_signature}" >&2
      exit 1
    fi
    if grep -q '^TeamIdentifier=not set$' <<<"${dmg_signature}"; then
      echo "[verify-macos-release] dmg signature is missing TeamIdentifier: ${dmg_path}" >&2
      echo "${dmg_signature}" >&2
      exit 1
    fi
  fi
done

if [[ "${REQUIRE_NOTARIZATION}" == "1" || "${REQUIRE_NOTARIZATION}" == "true" ]]; then
  echo "[verify-macos-release] validating app notarization"
  xcrun stapler validate "${APP_PATH}"
  spctl --assess --type execute --verbose=4 "${APP_PATH}"
  for dmg_path in "${dmg_files[@]}"; do
    echo "[verify-macos-release] validating dmg notarization: ${dmg_path}"
    xcrun stapler validate "${dmg_path}"
    spctl --assess --type open --context context:primary-signature --verbose=4 "${dmg_path}"
  done
fi

echo "[verify-macos-release] passed"
