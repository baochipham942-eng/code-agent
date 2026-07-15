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
DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-Install Agent Neo}"
DMG_FINDER_STYLE="${DMG_FINDER_STYLE:-1}"
DMG_WINDOW_BOUNDS="${DMG_WINDOW_BOUNDS:-{140, 90, 1060, 660}}"
DMG_ICON_SIZE="${DMG_ICON_SIZE:-128}"
DMG_APP_ICON_POSITION="${DMG_APP_ICON_POSITION:-{220, 260}}"
DMG_APPLICATIONS_ICON_POSITION="${DMG_APPLICATIONS_ICON_POSITION:-{655, 260}}"

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

style_installer_dmg() {
  local app_name="$1"

  if [[ "${DMG_FINDER_STYLE}" != "1" && "${DMG_FINDER_STYLE}" != "true" ]]; then
    return 0
  fi
  if ! command -v osascript >/dev/null 2>&1; then
    echo "[tauri-release-bundle] osascript not available; skipping dmg Finder style" >&2
    return 0
  fi

  osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "${DMG_VOLUME_NAME}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to ${DMG_WINDOW_BOUNDS}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${DMG_ICON_SIZE}
    set position of item "${app_name}" of container window to ${DMG_APP_ICON_POSITION}
    set position of item "Applications" of container window to ${DMG_APPLICATIONS_ICON_POSITION}
    update without registering applications
    delay 1
    close
  end tell
end tell
APPLESCRIPT
}

create_installer_dmg() {
  local app_bundle="$1"
  local dmg_path="$2"
  local signing_identity="$3"
  local app_name
  local mountpoint
  local mounted=0
  local rw_dmg_path
  local stage_root

  app_name="$(basename "${app_bundle}")"
  mountpoint="$(mktemp -d "${TMPDIR:-/tmp}/agent-neo-dmg-mount.XXXXXX")"
  rw_dmg_path="$(mktemp "${TMPDIR:-/tmp}/agent-neo-dmg.XXXXXX").dmg"
  stage_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-neo-dmg.XXXXXX")"

  (
    cleanup_installer_dmg() {
      if [[ "${mounted}" == "1" ]]; then
        hdiutil detach "${mountpoint}" -quiet >/dev/null 2>&1 \
          || hdiutil detach "${mountpoint}" -force -quiet >/dev/null 2>&1 \
          || true
      fi
      rm -rf "${mountpoint}" "${stage_root}"
      rm -f "${rw_dmg_path}"
    }
    trap cleanup_installer_dmg EXIT

    mkdir -p "${stage_root}"
    ditto "${app_bundle}" "${stage_root}/${app_name}"
    ln -s /Applications "${stage_root}/Applications"

    hdiutil create \
      -volname "${DMG_VOLUME_NAME}" \
      -srcfolder "${stage_root}" \
      -ov \
      -format UDRW \
      "${rw_dmg_path}"

    hdiutil attach "${rw_dmg_path}" \
      -readwrite \
      -nobrowse \
      -noautoopen \
      -mountpoint "${mountpoint}" \
      >/dev/null
    mounted=1

    style_installer_dmg "${app_name}" || echo "[tauri-release-bundle] failed to apply dmg Finder style; continuing with install layout" >&2
    sync

    hdiutil detach "${mountpoint}" -quiet >/dev/null \
      || hdiutil detach "${mountpoint}" -force -quiet >/dev/null
    mounted=0

    hdiutil convert "${rw_dmg_path}" \
      -format UDZO \
      -o "${dmg_path}" \
      >/dev/null
  )

  if [[ -n "${signing_identity}" ]]; then
    echo "[tauri-release-bundle] signing dmg: ${dmg_path}"
    codesign --force --timestamp --sign "${signing_identity}" "${dmg_path}"
  fi
}

# Run cargo tauri build in a subshell with Apple notarization env vars unset.
# Tauri auto-triggers notarytool inside `cargo tauri build` when it sees these
# variables, but we must sign nested Mach-O binaries (.node/.dylib + helper
# executables that ship under Contents/Resources or Contents/Resources/_up_/)
# BEFORE notarization,
# otherwise Apple rejects the submission. The unset is inside a subshell so the
# parent env stays intact for the downstream `release:notarize-macos` step.
(
  unset APPLE_ID APPLE_PASSWORD APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
  cargo tauri build --config "${CONFIG_FILE}" --ci "$@"
)

# 产物守卫：构建后立即校验更新器公钥已真正注入二进制，杜绝再发出 v0.20.0 式
# “占位符当公钥”的版本（会导致已安装客户端下载更新到 100% 后验签失败、永远无法自动更新）。
for app_path in "${ROOT_DIR}"/src-tauri/target/release/bundle/macos/*.app; do
  [[ -d "${app_path}" ]] || continue
  app_binary="$(find "${app_path}/Contents/MacOS" -maxdepth 1 -type f -perm -u+x | head -1)"
  if [[ -z "${app_binary}" ]]; then
    echo "[tauri-release-bundle] 找不到 ${app_path} 的主可执行文件，无法校验更新器公钥" >&2
    exit 1
  fi
  TAURI_UPDATER_PUBKEY="${UPDATER_PUBKEY}" node "${ROOT_DIR}/scripts/verify-updater-pubkey.mjs" "${app_binary}"
done

# Post-build: sign nested macOS Mach-O binaries that Tauri did not touch, then
# re-sign the .app shell and rebuild + sign the .dmg so hashes stay consistent.
if [[ "$(uname -s)" == "Darwin" && -n "${SIGNING_IDENTITY}" ]]; then
  ENTITLEMENTS_PATH="${ROOT_DIR}/src-tauri/Entitlements.plist"
  if [[ ! -f "${ENTITLEMENTS_PATH}" ]]; then
    echo "Missing entitlements file at ${ENTITLEMENTS_PATH}" >&2
    exit 1
  fi

  release_resource_root() {
    local app_path="$1"
    local resources_dir="${app_path}/Contents/Resources"
    local legacy_root="${resources_dir}/_up_"
    if [[ -d "${legacy_root}" ]]; then
      printf '%s\n' "${legacy_root}"
    else
      printf '%s\n' "${resources_dir}"
    fi
  }

  sign_nested_binary() {
    local target="$1"
    local use_entitlements="$2"
    local force_resign="${3:-0}"

    # Skip non-darwin .node files (PE32 win32 / ELF linux prebuilds also ship).
    if ! file "${target}" 2>/dev/null | grep -q "Mach-O"; then
      return 0
    fi

    # Skip files already signed with a Developer ID Application certificate
    # (avoids re-signing Tauri's own outputs and the Rust binary).
    if [[ "${force_resign}" != "1" ]] \
      && codesign -dvv "${target}" 2>&1 | grep -q "Authority=Developer ID Application:"; then
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
    resource_scan_root="$(release_resource_root "${app_path}")"
    node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${resource_scan_root}"

    echo "[tauri-release-bundle] signing nested Mach-O binaries inside ${app_path}"

    # Pass 1: libraries and native node addons (no entitlements needed).
    while IFS= read -r -d '' nested; do
      sign_nested_binary "${nested}" "0"
    done < <(find "${app_path}" \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) -type f -print0)

    # Pass 2: standalone executable helpers (need entitlements + hardened runtime).
    # Enumerated by basename. The bundled Node binary must always be re-signed
    # with our app identity even though the upstream archive already carries a
    # Node.js Foundation Developer ID signature. A fresh install otherwise has
    # to validate a second team identity before dyld can start Node, which can
    # stall the desktop health check when Gatekeeper ticket lookup is slow.
    while IFS= read -r -d '' nested; do
      force_resign=0
      if [[ "${nested}" == */dist/bundled-node/bin/node ]]; then
        force_resign=1
      fi
      sign_nested_binary "${nested}" "1" "${force_resign}"
    done < <(find "${app_path}" -type f \( -name "system-audio-capture" -o -name "spawn-helper" -o -name "vision-tagger" -o -name "vision-ocr" -o -name "rtk" -o -name "uv" -o -name "pdftoppm" -o -path "*/dist/bundled-node/bin/node" \) -print0)

    # 两趟签名靠「扩展名 + basename 白名单」枚举，漏掉一个可执行文件不会有任何报错——
    # 直到 Apple 公证审回 Invalid，而审回并不指名是哪个文件（2026-07-15 poppler 的
    # pdftoppm 就这么漏过去，烧掉 12 分钟编译 + 一轮公证往返才定位到）。这里在公证前对平账。
    node "${ROOT_DIR}/scripts/verify-bundle-signatures.mjs" "${app_path}"

    echo "[tauri-release-bundle] re-signing .app shell: ${app_path}"
    codesign --force --options runtime --timestamp \
      --entitlements "${ENTITLEMENTS_PATH}" \
      --sign "${SIGNING_IDENTITY}" "${app_path}"
    codesign --verify --deep --strict --verbose=2 "${app_path}"
  done

  # Rebuild the .dmg from the freshly-signed .app so its contents match.
  # tauri bundle.targets 现为 ["app"]（不再让 tauri 跑 bundle_dmg.sh 弹 Finder 安装窗），
  # 所以这里必须自己 mkdir DMG_DIR：dmg 完全由本脚本从重签后的 .app 干净创建。
  DMG_DIR="${ROOT_DIR}/src-tauri/target/release/bundle/dmg"
  mkdir -p "${DMG_DIR}"
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
      create_installer_dmg "${APP_BUNDLE}" "${DMG_PATH}" "${SIGNING_IDENTITY}"
    fi
    shopt -u nullglob
  fi
else
  # Non-Darwin or no signing identity (REQUIRE_DEVELOPER_ID=0): just run the
  # release security scan without touching signatures.
  for app_path in "${ROOT_DIR}"/src-tauri/target/release/bundle/macos/*.app; do
    [[ -d "${app_path}" ]] || continue
    resources_dir="${app_path}/Contents/Resources"
    legacy_root="${resources_dir}/_up_"
    if [[ -d "${legacy_root}" ]]; then
      node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${legacy_root}"
    else
      node "${ROOT_DIR}/scripts/release-security-scan.mjs" "${resources_dir}"
    fi
  done
fi
