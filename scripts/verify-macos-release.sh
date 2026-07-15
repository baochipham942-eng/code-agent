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

detach_dmg_mountpoint() {
  local mountpoint="$1"

  hdiutil detach "${mountpoint}" -quiet >/dev/null 2>&1 \
    || hdiutil detach "${mountpoint}" -force -quiet >/dev/null 2>&1 \
    || true
}

fail_dmg_install_layout() {
  local mountpoint="$1"
  local message="$2"

  echo "${message}" >&2
  echo "[verify-macos-release] dmg root contents:" >&2
  ls -la "${mountpoint}" >&2 || true
  detach_dmg_mountpoint "${mountpoint}"
  rm -rf "${mountpoint}"
  exit 1
}

verify_dmg_install_layout() {
  local dmg_path="$1"
  local mountpoint
  local applications_target

  mountpoint="$(mktemp -d "${TMPDIR:-/tmp}/agent-neo-dmg-verify.XXXXXX")"

  if ! hdiutil attach "${dmg_path}" -readonly -nobrowse -noautoopen -mountpoint "${mountpoint}" >/dev/null; then
    rm -rf "${mountpoint}"
    echo "[verify-macos-release] failed to mount dmg for layout verification: ${dmg_path}" >&2
    exit 1
  fi

  if [[ ! -d "${mountpoint}/${APP_NAME}.app" ]]; then
    fail_dmg_install_layout "${mountpoint}" "[verify-macos-release] dmg missing ${APP_NAME}.app at root: ${dmg_path}"
  fi

  if [[ ! -L "${mountpoint}/Applications" ]]; then
    fail_dmg_install_layout "${mountpoint}" "[verify-macos-release] dmg missing Applications symlink: ${dmg_path}"
  fi

  applications_target="$(readlink "${mountpoint}/Applications")"
  if [[ "${applications_target}" != "/Applications" ]]; then
    fail_dmg_install_layout "${mountpoint}" "[verify-macos-release] dmg Applications symlink points to ${applications_target}, expected /Applications: ${dmg_path}"
  fi

  detach_dmg_mountpoint "${mountpoint}"
  rm -rf "${mountpoint}"
}

echo "[verify-macos-release] scanning bundled resources"
echo "[verify-macos-release] resources root: ${RESOURCES_ROOT}"
node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${RESOURCES_ROOT}"
node "${ROOT_DIR}/scripts/tauri-resource-inventory.mjs" --root "${RESOURCES_ROOT}"

POPPLER_ROOT="${RESOURCES_ROOT}/scripts/poppler"
POPPLER_BIN="${POPPLER_ROOT}/bin/pdftoppm"
POPPLER_NOTICES="${POPPLER_ROOT}/compliance/THIRD_PARTY_NOTICES.txt"
POPPLER_PROVENANCE="${POPPLER_ROOT}/compliance/binary-provenance.json"
POPPLER_MANIFEST="${POPPLER_ROOT}/manifest/sidecar-manifest.json"
if [[ ! -x "${POPPLER_BIN}" || ! -s "${POPPLER_NOTICES}" || ! -s "${POPPLER_PROVENANCE}" || ! -s "${POPPLER_MANIFEST}" ]]; then
  echo "[verify-macos-release] Poppler sidecar/compliance files are incomplete under ${POPPLER_ROOT}" >&2
  exit 1
fi
if ! find "${POPPLER_ROOT}/compliance/licenses" -type f -size +0c -print -quit | grep -q .; then
  echo "[verify-macos-release] Poppler sidecar has no bundled license texts" >&2
  exit 1
fi
EXPECTED_POPPLER_ARCH="$(uname -m)"
EXPECTED_POPPLER_PLATFORM="darwin-arm64"
if [[ "${EXPECTED_POPPLER_ARCH}" == "x86_64" ]]; then
  EXPECTED_POPPLER_PLATFORM="darwin-x64"
fi
if [[ "$(lipo -archs "${POPPLER_BIN}")" != "${EXPECTED_POPPLER_ARCH}" ]]; then
  echo "[verify-macos-release] Poppler architecture mismatch: $(lipo -archs "${POPPLER_BIN}")" >&2
  exit 1
fi
# --sidecar-signed：这份是 .app 里已过代码签名的副本。签名改写了 Mach-O 字节，而 manifest
# 的哈希来自没有签名证书的 promotion workflow，永远是未签名的——「过公证」与「逐字节等于
# manifest」互斥。该模式把 Mach-O 的哈希对账换成 Developer ID 签名对账（非 Mach-O 仍逐字节），
# 字节完整性由下载时 fetch-poppler-sidecar.mjs 按 lock 的 sha256 校验兜住。
node "${ROOT_DIR}/scripts/verify-poppler-release-gate.mjs" \
  --manifest "${POPPLER_MANIFEST}" \
  --sidecar-dir "${POPPLER_ROOT}" \
  --sidecar-signed \
  --platform "${EXPECTED_POPPLER_PLATFORM}"
"${POPPLER_BIN}" -v >/dev/null 2>&1
echo "[verify-macos-release] Poppler lock, manifest, sidecar files, notices, license texts and native architecture verified"

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
const requiredKeyIds = ["production-2026-05-17", "production-2026-06-15"];
const missingKeyIds = requiredKeyIds.filter((keyId) => typeof keys[keyId] !== "string" || keys[keyId].trim().length === 0);
if (missingKeyIds.length > 0) {
  console.error(`[verify-macos-release] control-plane public keys file is missing required keys: ${missingKeyIds.join(", ")}`);
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
  echo "[verify-macos-release] verifying dmg install layout: ${dmg_path}"
  verify_dmg_install_layout "${dmg_path}"
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
