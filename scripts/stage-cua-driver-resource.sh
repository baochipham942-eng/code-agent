#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"

# 身份/产物名按 NEO_CHANNEL 派生（缺省=生产）。app_ready() 会校验 Info.plist 的
# CFBundleIdentifier，写死值会导致换渠道后误判 not ready 而反复重建。
# shellcheck source=lib/cua-channel.sh
source "${SCRIPT_DIR}/lib/cua-channel.sh"
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

  # 版本也要对上：签名有效的**旧版本**同样会被当成就绪用掉，跨 worktree 缓存后
  # 这就是「A 树播种 0.14.1，B 树升到 0.14.2 却拿到 A 的旧驱动」——静默且难查。
  local version
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app_path}/Contents/Info.plist" 2>/dev/null)" || return 1
  [[ "${version}" == "${CUA_DRIVER_VERSION}" ]] || return 1

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

publish_to_cache() {
  local app_path="$1"
  mkdir -p "${CUA_CACHE_DIR}" || return 0
  rm -rf "${CUA_CACHED_APP}.tmp"
  if ditto --noqtn "${app_path}" "${CUA_CACHED_APP}.tmp" 2>/dev/null; then
    rm -rf "${CUA_CACHED_APP}"
    mv "${CUA_CACHED_APP}.tmp" "${CUA_CACHED_APP}"
    echo "[stage-cua-driver-resource] cached helper for other worktrees: ${CUA_CACHED_APP}"
  else
    rm -rf "${CUA_CACHED_APP}.tmp"
    echo "[stage-cua-driver-resource] 写机器级缓存失败（不影响本次构建）: ${CUA_CACHED_APP}" >&2
  fi
}

if app_ready "${STAGED_APP}"; then
  remove_legacy_app
  # 顺手把本树已就绪的产物播种到机器级缓存，让下一个新 worktree 不用再 fetch 一次。
  app_ready "${CUA_CACHED_APP}" || publish_to_cache "${STAGED_APP}"
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

if app_ready "${CUA_CACHED_APP}"; then
  rm -rf "${STAGED_APP}"
  if ditto --noqtn "${CUA_CACHED_APP}" "${STAGED_APP}" 2>/dev/null && app_ready "${STAGED_APP}"; then
    remove_legacy_app
    echo "[stage-cua-driver-resource] restored helper from machine cache: ${CUA_CACHED_APP}"
    exit 0
  fi
  # 缓存坏了不算数：清掉半成品，照常报错让操作者重新 fetch，别拿半个 .app 去打包。
  rm -rf "${STAGED_APP}"
  echo "[stage-cua-driver-resource] 机器级缓存不可用，回退到 fetch: ${CUA_CACHED_APP}" >&2
fi

# 缓存为什么没兜住，要说清楚。只报 "missing staged" 的话，三种成因（从没播过种 / 目录被清掉 /
# 缓存里那份校验不过）看起来一模一样，而处置完全不同——2026-08-06 就因为分不清，
# 花了一轮排查才发现是 macOS 把整个缓存根目录清了。
cache_diagnosis() {
  if [[ ! -d "${CUA_CACHE_DIR}" ]]; then
    echo "缓存目录不存在（${CUA_CACHE_DIR}）——本机还没播过种，或它被清掉了"
  elif [[ ! -d "${CUA_CACHED_APP}" ]]; then
    echo "缓存目录在，但没有本渠道那份（${CUA_CACHED_APP}）"
  else
    echo "缓存里那份未通过校验（bundle id / 版本 ${CUA_DRIVER_VERSION} / codesign 之一不符）：${CUA_CACHED_APP}"
  fi
}

# 换渠道后必须带同一个 NEO_CHANNEL 去 fetch，否则重建出来的还是另一个渠道的产物。
CHANNEL_PREFIX=""
[[ "${NEO_CHANNEL:-production}" == "production" ]] || CHANNEL_PREFIX="NEO_CHANNEL=${NEO_CHANNEL} "
cat >&2 <<EOF
[stage-cua-driver-resource] missing staged ${CUA_APP_NAME}.app (bundle id ${CUA_BUNDLE_ID})
机器级缓存: $(cache_diagnosis)
Run one of:
  ${CHANNEL_PREFIX}CUA_FETCH_UPSTREAM=1 bash scripts/fetch-cua-driver.sh
  ${CHANNEL_PREFIX}bash scripts/fetch-cua-driver.sh
EOF
exit 1
