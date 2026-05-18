#!/usr/bin/env bash
# ============================================================================
# publish-release.sh - "build 完成 → 装机可用 → GitHub release notes 收口" 一把梭
# ============================================================================
# 把首次 release v0.16.75 手动跑通的 7 步固化下来：
#
#   1. 校验 dmg 产物
#   2. 从 dmg 挂载 + cp .app 到 /Applications（绕开 tauri-install.sh 的 Dev 重签）
#   3. 给 /Applications 里的 .app 单独 staple（dmg 内是 staple 之前的状态）
#   4. 本地最终校验（codesign / spctl / stapler validate）
#   5. 上传 dmg 到 GitHub release（已存在的 v0.16.X tag）
#   6. 算 SHA-256 + 写回 release notes
#   7. 清场 + 启动
#
# 前置：
#   - npm run build && npm run build:web && cargo tauri build 已经跑过
#   - gh CLI 已登录（认 baochipham942-eng 账号）
#   - .app 已经用 Developer ID Application: jay lem (D7CVTJ72NV) 签过 + notarize 通过
#
# 用法：
#   bash scripts/publish-release.sh                # 自动从 package.json 读 version
#   bash scripts/publish-release.sh 0.16.76        # 显式版本号
#   bash scripts/publish-release.sh --no-install   # 跳过装机（CI 用）
#   bash scripts/publish-release.sh --no-upload    # 只装本机，不传 GitHub
# ============================================================================

set -euo pipefail

# ---- 常量（这些事实在任务上下文里写死了）---------------------------------
readonly APPLE_TEAM_ID="D7CVTJ72NV"
readonly SIGNING_AUTHORITY="Developer ID Application: jay lem (D7CVTJ72NV)"
readonly APP_BUNDLE_ID="com.linchen.code-agent"
readonly APP_NAME="Agent Neo"
readonly GITHUB_REPO="baochipham942-eng/code-agent"
readonly MOUNTPOINT="/tmp/agent-neo-publish-mount"
readonly WEB_PORT=8180

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DMG_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle/dmg"

# ---- CLI 参数解析 ---------------------------------------------------------
VERSION=""
DO_INSTALL=1
DO_UPLOAD=1

for arg in "$@"; do
  case "$arg" in
    --no-install) DO_INSTALL=0 ;;
    --no-upload)  DO_UPLOAD=0 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    --*)
      echo "[publish-release] 未知参数: $arg" >&2
      exit 2
      ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$arg"
      else
        echo "[publish-release] 多余的位置参数: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

log()  { echo "[publish-release] $*"; }
fail() { echo "[publish-release][FAIL] $*" >&2; exit 1; }

# ---- 0. 读 version --------------------------------------------------------
resolve_version() {
  log "step 0: resolve version"
  if [[ -z "$VERSION" ]]; then
    if ! command -v node >/dev/null 2>&1; then
      fail "node 不可用，无法从 package.json 读 version；请显式传版本号：bash scripts/publish-release.sh 0.16.76"
    fi
    VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
  fi
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    fail "version 不合法: '$VERSION'（期望 x.y.z）"
  fi
  log "  version = $VERSION"
}

# ---- 1. 校验 dmg 产物存在 -------------------------------------------------
verify_dmg_artifact() {
  log "step 1: verify dmg artifact"
  if [[ ! -d "$DMG_DIR" ]]; then
    fail "dmg 目录不存在: $DMG_DIR
        recover: 跑 'npm run build && npm run build:web && HTTPS_PROXY=http://127.0.0.1:7897 cargo tauri build'"
  fi

  # 优先匹配当前 version 的 dmg；没有再退化到任意 dmg
  local candidate=""
  local versioned
  versioned="$(ls "$DMG_DIR"/*"${VERSION}"*.dmg 2>/dev/null | head -n 1 || true)"
  if [[ -n "$versioned" ]]; then
    candidate="$versioned"
  else
    candidate="$(ls "$DMG_DIR"/*.dmg 2>/dev/null | head -n 1 || true)"
  fi

  if [[ -z "$candidate" ]]; then
    fail "$DMG_DIR 下没有 .dmg 文件
        recover: 重新跑 cargo tauri build"
  fi

  DMG_PATH="$candidate"
  log "  dmg = $DMG_PATH"
}

# ---- 2. 从 dmg 装到 /Applications ----------------------------------------
install_from_dmg() {
  if [[ "$DO_INSTALL" -eq 0 ]]; then
    log "step 2: install (SKIPPED, --no-install)"
    return 0
  fi
  log "step 2: install .app from dmg to /Applications"

  # 先清理可能挂在 MOUNTPOINT 上的旧挂载（上次脚本中断留下的）
  if mount | grep -q " on $MOUNTPOINT (hfs"; then
    hdiutil detach "$MOUNTPOINT" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$MOUNTPOINT"
  mkdir -p "$MOUNTPOINT"

  # 关掉正在跑的实例，否则 cp 会因为文件被占用半失败
  pkill -f "/Applications/$APP_NAME.app" 2>/dev/null || true
  sleep 1

  log "  attach $DMG_PATH -> $MOUNTPOINT"
  if ! hdiutil attach "$DMG_PATH" -mountpoint "$MOUNTPOINT" -nobrowse -quiet; then
    fail "hdiutil attach 失败
        recover: ls /Volumes 看是不是别的挂载点占了，hdiutil detach /Volumes/'$APP_NAME' 后再跑"
  fi

  local src_app="$MOUNTPOINT/$APP_NAME.app"
  if [[ ! -d "$src_app" ]]; then
    hdiutil detach "$MOUNTPOINT" -force >/dev/null 2>&1 || true
    fail "dmg 里没找到 '$APP_NAME.app'（实际内容: $(ls "$MOUNTPOINT" 2>/dev/null | tr '\n' ' ')）"
  fi

  log "  rm -rf /Applications/$APP_NAME.app && cp -R"
  rm -rf "/Applications/$APP_NAME.app"
  cp -R "$src_app" "/Applications/$APP_NAME.app"

  log "  detach $MOUNTPOINT"
  hdiutil detach "$MOUNTPOINT" -quiet || hdiutil detach "$MOUNTPOINT" -force -quiet || true
  rm -rf "$MOUNTPOINT"
}

# ---- 3. staple 装到 /Applications 的 .app --------------------------------
staple_installed_app() {
  if [[ "$DO_INSTALL" -eq 0 ]]; then
    log "step 3: staple (SKIPPED, --no-install)"
    return 0
  fi
  log "step 3: staple /Applications/$APP_NAME.app"
  if ! xcrun stapler staple "/Applications/$APP_NAME.app"; then
    fail "stapler staple 失败
        recover: 1) 确认 notarize 已通过；2) xcrun stapler staple '/Applications/$APP_NAME.app' 看具体错误"
  fi
}

# ---- 4. 本地最终校验 ------------------------------------------------------
verify_installed_app() {
  if [[ "$DO_INSTALL" -eq 0 ]]; then
    log "step 4: verify installed app (SKIPPED, --no-install)"
    return 0
  fi
  log "step 4: verify installed app (codesign / spctl / stapler validate)"
  local app="/Applications/$APP_NAME.app"

  log "  4.1 codesign -dvv"
  local codesign_out
  codesign_out="$(codesign -dvv "$app" 2>&1)"
  if ! grep -q "Authority=$SIGNING_AUTHORITY" <<<"$codesign_out"; then
    echo "$codesign_out" >&2
    fail "codesign Authority 不匹配，期望: $SIGNING_AUTHORITY
        recover: .app 没被正确签名；回到 tauri build 前确认 signingIdentity 配置"
  fi

  log "  4.2 spctl -a -vvv"
  local spctl_out
  spctl_out="$(spctl -a -vvv "$app" 2>&1)" || true
  if ! grep -q "accepted" <<<"$spctl_out"; then
    echo "$spctl_out" >&2
    fail "spctl 未 accepted
        recover: 检查 notarize 是否过 + step 3 是否成功 staple"
  fi
  if ! grep -q "source=Notarized Developer ID" <<<"$spctl_out"; then
    echo "$spctl_out" >&2
    fail "spctl source 不是 'Notarized Developer ID'
        recover: 这个包没 notarize；先 'xcrun notarytool submit' 再回到 step 3"
  fi

  log "  4.3 xcrun stapler validate"
  local stapler_out
  stapler_out="$(xcrun stapler validate "$app" 2>&1)"
  if ! grep -q "worked" <<<"$stapler_out"; then
    echo "$stapler_out" >&2
    fail "stapler validate 未 worked
        recover: 重跑 step 3 的 stapler staple"
  fi

  log "  ✓ codesign / spctl / stapler 全部通过"
}

# ---- 5. 上传 dmg 到 GitHub release ---------------------------------------
upload_to_github() {
  if [[ "$DO_UPLOAD" -eq 0 ]]; then
    log "step 5: upload to GitHub (SKIPPED, --no-upload)"
    return 0
  fi
  log "step 5: upload dmg to GitHub release v$VERSION"

  if ! command -v gh >/dev/null 2>&1; then
    fail "gh CLI 不可用
        recover: brew install gh && gh auth login"
  fi

  # 校验 release 存在
  if ! gh release view "v$VERSION" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    fail "GitHub release v$VERSION 不存在
        recover: 先 git tag v$VERSION + git push --tags + gh release create v$VERSION --repo $GITHUB_REPO"
  fi

  # 拷贝去掉空格的文件名到 /tmp，避免 URL 转义和 gh upload 的歧义
  UPLOAD_NAME="Agent-Neo-${VERSION}-arm64.dmg"
  UPLOAD_PATH="/tmp/$UPLOAD_NAME"
  cp "$DMG_PATH" "$UPLOAD_PATH"

  log "  gh release upload v$VERSION $UPLOAD_NAME --clobber"
  if ! gh release upload "v$VERSION" "$UPLOAD_PATH" --repo "$GITHUB_REPO" --clobber; then
    fail "gh release upload 失败
        recover: gh auth status 看登录态；网络问题重跑即可（--clobber 幂等）"
  fi
}

# ---- 6. 算 SHA-256 + 更新 release notes ----------------------------------
update_release_notes() {
  if [[ "$DO_UPLOAD" -eq 0 ]]; then
    log "step 6: update release notes (SKIPPED, --no-upload)"
    return 0
  fi
  log "step 6: compute SHA-256 + update release notes"

  local sha
  sha="$(shasum -a 256 "$UPLOAD_PATH" | awk '{print $1}')"
  log "  SHA-256 = $sha"

  local notes
  notes="$(cat <<EOF
## Install

\`\`\`bash
# 下载
curl -L -o /tmp/$UPLOAD_NAME \\
  https://github.com/$GITHUB_REPO/releases/download/v$VERSION/$UPLOAD_NAME

# 校验
shasum -a 256 /tmp/$UPLOAD_NAME
# 期望: $sha

# 装机
hdiutil attach /tmp/$UPLOAD_NAME -nobrowse
cp -R "/Volumes/$APP_NAME/$APP_NAME.app" /Applications/
hdiutil detach "/Volumes/$APP_NAME"
xattr -dr com.apple.quarantine "/Applications/$APP_NAME.app"
open -n "/Applications/$APP_NAME.app"
\`\`\`

## Verify

- Bundle ID: \`$APP_BUNDLE_ID\`
- Apple Team ID: \`$APPLE_TEAM_ID\`
- Signing identity: \`$SIGNING_AUTHORITY\`
- SHA-256: \`$sha\`
EOF
)"

  if ! gh release edit "v$VERSION" --repo "$GITHUB_REPO" --notes "$notes"; then
    fail "gh release edit 失败
        recover: 手动 gh release edit v$VERSION --repo $GITHUB_REPO --notes-file <(...) 重写 notes"
  fi
}

# ---- 7. 清场 + 启动 -------------------------------------------------------
launch_app() {
  if [[ "$DO_INSTALL" -eq 0 ]]; then
    log "step 7: launch (SKIPPED, --no-install)"
    return 0
  fi
  log "step 7: kill zombie webServer + launch app"

  # 杀 zombie webServer
  pkill -f "dist/web/webServer.cjs" 2>/dev/null || true

  # 清 8180 端口
  local pids
  pids="$(lsof -ti tcp:$WEB_PORT 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "  killing process on :$WEB_PORT (pid: $pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi

  log "  open -n /Applications/$APP_NAME.app"
  open -n "/Applications/$APP_NAME.app"
}

# ---- 主流程 ---------------------------------------------------------------
main() {
  resolve_version
  verify_dmg_artifact
  install_from_dmg
  staple_installed_app
  verify_installed_app
  upload_to_github
  update_release_notes
  launch_app

  log "done."
  log "  version:  $VERSION"
  [[ "$DO_INSTALL" -eq 1 ]] && log "  installed: /Applications/$APP_NAME.app"
  [[ "$DO_UPLOAD" -eq 1 ]]  && log "  release:   https://github.com/$GITHUB_REPO/releases/tag/v$VERSION"
}

main
