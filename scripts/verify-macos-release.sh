#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Agent Neo}"
APP_PATH="${APP_PATH:-${ROOT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}.app}"
DMG_DIR="${DMG_DIR:-${ROOT_DIR}/src-tauri/target/release/bundle/dmg}"
REQUIRE_NOTARIZATION="${REQUIRE_NOTARIZATION:-0}"
REQUIRE_DEVELOPER_ID="${REQUIRE_DEVELOPER_ID:-${REQUIRE_NOTARIZATION}}"
REQUIRE_CONTROL_PLANE_PUBLIC_KEYS="${REQUIRE_CONTROL_PLANE_PUBLIC_KEYS:-${REQUIRE_NOTARIZATION}}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[verify-macos-release] skipped: macOS release verification requires Darwin"
  exit 0
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "[verify-macos-release] missing app bundle: ${APP_PATH}" >&2
  exit 1
fi

APP_RESOURCES_DIR="${APP_PATH}/Contents/Resources"
LEGACY_RESOURCES_ROOT="${APP_RESOURCES_DIR}/_up_"
if [[ -d "${LEGACY_RESOURCES_ROOT}" ]]; then
  RESOURCES_ROOT="${LEGACY_RESOURCES_ROOT}"
elif [[ -d "${APP_RESOURCES_DIR}/dist" || -d "${APP_RESOURCES_DIR}/node_modules" || -d "${APP_RESOURCES_DIR}/scripts" ]]; then
  RESOURCES_ROOT="${APP_RESOURCES_DIR}"
else
  echo "[verify-macos-release] missing bundled resources; checked:" >&2
  echo "  - ${LEGACY_RESOURCES_ROOT}" >&2
  echo "  - ${APP_RESOURCES_DIR}" >&2
  exit 1
fi

find_first_existing_file() {
  local label="$1"
  shift

  for candidate in "$@"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "[verify-macos-release] missing ${label}; checked:" >&2
  for candidate in "$@"; do
    echo "  - ${candidate}" >&2
  done
  return 1
}

echo "[verify-macos-release] scanning bundled resources"
echo "[verify-macos-release] resources root: ${RESOURCES_ROOT}"
node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${RESOURCES_ROOT}"
node "${ROOT_DIR}/scripts/tauri-resource-inventory.mjs" --root "${RESOURCES_ROOT}"

BUNDLED_NODE_PATH="$(
  find_first_existing_file "bundled Node binary" \
    "${RESOURCES_ROOT}/dist/bundled-node/bin/node" \
    "${RESOURCES_ROOT}/dist/bundled-node/node" \
    "${APP_PATH}/Contents/Resources/dist/bundled-node/bin/node" \
    "${APP_PATH}/Contents/Resources/dist/bundled-node/node"
)"
if [[ ! -x "${BUNDLED_NODE_PATH}" ]]; then
  echo "[verify-macos-release] bundled Node is not executable: ${BUNDLED_NODE_PATH}" >&2
  exit 1
fi

echo "[verify-macos-release] bundled node: ${BUNDLED_NODE_PATH}"
"${BUNDLED_NODE_PATH}" -p '"[verify-macos-release] bundled node runtime: " + process.version + " ABI " + process.versions.modules + " " + process.platform + "-" + process.arch'

REQUIRED_BETTER_SQLITE3_NATIVE="${RESOURCES_ROOT}/dist/native/better-sqlite3/build/Release/better_sqlite3.node"
if [[ ! -f "${REQUIRED_BETTER_SQLITE3_NATIVE}" ]]; then
  echo "[verify-macos-release] missing bundled better-sqlite3 native file: ${REQUIRED_BETTER_SQLITE3_NATIVE}" >&2
  exit 1
fi

better_sqlite3_native_paths=("${REQUIRED_BETTER_SQLITE3_NATIVE}")
OPTIONAL_BETTER_SQLITE3_NATIVE="${RESOURCES_ROOT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [[ -f "${OPTIONAL_BETTER_SQLITE3_NATIVE}" ]]; then
  better_sqlite3_native_paths+=("${OPTIONAL_BETTER_SQLITE3_NATIVE}")
fi

for native_path in "${better_sqlite3_native_paths[@]}"; do
  if ! file "${native_path}" | grep -q "Mach-O"; then
    echo "[verify-macos-release] better-sqlite3 native file is not a macOS Mach-O binary: ${native_path}" >&2
    file "${native_path}" >&2
    exit 1
  fi

  "${BUNDLED_NODE_PATH}" -e '
const nativePath = process.argv[1];
try {
  const binding = require(nativePath);
  if (!binding || typeof binding.Database !== "function") {
    throw new Error("native binding did not expose Database");
  }
  console.log(`[verify-macos-release] better-sqlite3 native loads with bundled Node ABI ${process.versions.modules}: ${nativePath}`);
} catch (error) {
  console.error(`[verify-macos-release] better-sqlite3 native failed under bundled Node: ${nativePath}`);
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
' "${native_path}"
done

CONTROL_PLANE_PUBLIC_KEYS_FILE="${RESOURCES_ROOT}/dist/web/control-plane-public-keys.json"
if [[ "${REQUIRE_CONTROL_PLANE_PUBLIC_KEYS}" == "1" || "${REQUIRE_CONTROL_PLANE_PUBLIC_KEYS}" == "true" ]]; then
  if [[ ! -f "${CONTROL_PLANE_PUBLIC_KEYS_FILE}" ]]; then
    echo "[verify-macos-release] missing control-plane public keys file: ${CONTROL_PLANE_PUBLIC_KEYS_FILE}" >&2
    exit 1
  fi
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const keys = parsed && typeof parsed === "object" && parsed.keys && typeof parsed.keys === "object"
  ? parsed.keys
  : {};
if (Object.keys(keys).length === 0) {
  console.error(`[verify-macos-release] control-plane public keys file has no keys: ${file}`);
  process.exit(1);
}
' "${CONTROL_PLANE_PUBLIC_KEYS_FILE}"
fi

echo "[verify-macos-release] verifying app signature"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

if [[ "${REQUIRE_DEVELOPER_ID}" == "1" || "${REQUIRE_DEVELOPER_ID}" == "true" ]]; then
  app_signature="$(codesign -dv --verbose=4 "${APP_PATH}" 2>&1)"
  if ! grep -q '^Authority=Developer ID Application:' <<<"${app_signature}"; then
    echo "[verify-macos-release] app is not signed with a Developer ID Application identity" >&2
    echo "${app_signature}" >&2
    exit 1
  fi
  if ! grep -q '^TeamIdentifier=[A-Za-z0-9]' <<<"${app_signature}" || grep -q '^TeamIdentifier=not set$' <<<"${app_signature}"; then
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
    if ! grep -q '^TeamIdentifier=[A-Za-z0-9]' <<<"${dmg_signature}" || grep -q '^TeamIdentifier=not set$' <<<"${dmg_signature}"; then
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
