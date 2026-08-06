#!/bin/bash
# ============================================================================
# tauri-install-dev.sh — 安装「测试/开发包」到 /Applications，与生产包并存
# ============================================================================
# 与 tauri-install.sh（生产）的区别：
#   - 只处理 "Agent Neo Dev.app"，绝不 rm / 重签 / 反注册生产 "Agent Neo.app"
#   - 不跑 LaunchServices 全量去重（那会误伤生产包的注册）
#   - 测试包数据走 ~/.code-agent-dev（由 Rust 按 .dev identifier 注入 CODE_AGENT_DATA_DIR）
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
SLOT_META="$PROJECT_ROOT/src-tauri/.dev-slot.json"
# 槽名与端口都从 gen-dev-slot-conf 生成的元数据里读，不在 shell 里再实现一遍后缀规则——
# 两处各算一遍就会在换槽时错开，表现是"打好的包找不到"或"装到了别的槽上"。
if [ ! -f "$SLOT_META" ]; then
  echo "Error: 找不到 ${SLOT_META}（先跑 npm run tauri:package:dev）" >&2
  exit 1
fi
read_slot_field() {
  SLOT_META="$SLOT_META" SLOT_FIELD="$1" node -e '
    const fs = require("fs");
    const meta = JSON.parse(fs.readFileSync(process.env.SLOT_META, "utf8"));
    const value = meta[process.env.SLOT_FIELD];
    if (value === undefined || value === null || value === "") {
      console.error(`slot metadata has no ${process.env.SLOT_FIELD}`);
      process.exit(1);
    }
    process.stdout.write(String(value));
  '
}
APP_NAME="${APP_NAME:-$(read_slot_field productName)}" || exit 1
# 打包后冒烟用本槽端口，否则装槽 2 时会去探 8181，撞上别人正在跑的槽 1。
DEV_APP_WEB_PORT="${DEV_APP_WEB_PORT:-$(read_slot_field webPort)}" || exit 1
export DEV_APP_WEB_PORT
SIGNING_IDENTITY="${SIGNING_IDENTITY:-Code Agent Dev}"
ENTITLEMENTS="$PROJECT_ROOT/src-tauri/Entitlements.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

# shellcheck source=lib/tauri-app-resources.sh
source "$SCRIPT_DIR/lib/tauri-app-resources.sh"

strip_local_secrets() {
  local app_path="$1"
  local resources_root="$app_path/Contents/Resources/_up_"
  [ -d "$resources_root" ] || return 0
  rm -f "$resources_root/.dev-token" "$resources_root/.env" "$resources_root/.env.local"
}

resign_app_if_possible() {
  local app_path="$1"
  if security find-identity -v -p codesigning | grep -Fq "\"$SIGNING_IDENTITY\""; then
    codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" "$app_path"
  else
    # 没有自签身份时退回 ad-hoc，保证可启动（TCC 授权可能每次重签后重新询问，测试包可接受）
    echo "[install-dev] signing identity '$SIGNING_IDENTITY' not found; falling back to ad-hoc signature"
    codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign - "$app_path"
  fi
}

warn_about_existing_install() {
  local installed_app="/Applications/$APP_NAME.app"
  local build_info="$installed_app/Contents/Resources/build-info.json"
  local incoming_branch
  local incoming_commit_short
  [ -d "$installed_app" ] || return 0

  if [ ! -f "$build_info" ]; then
    echo "[install-dev] 槽位里是无 build-info 的旧包，将继续覆盖"
    return 0
  fi

  incoming_branch="$(git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  incoming_commit_short="$(git -C "$PROJECT_ROOT" rev-parse --short=7 HEAD 2>/dev/null || true)"

  CURRENT_PROJECT_ROOT="$PROJECT_ROOT" \
  INCOMING_BRANCH="$incoming_branch" \
  INCOMING_COMMIT_SHORT="$incoming_commit_short" \
  EXISTING_BUILD_INFO="$build_info" \
  node -e '
    const fs = require("fs");
    try {
      const info = JSON.parse(fs.readFileSync(process.env.EXISTING_BUILD_INFO, "utf8"));
      const existingInstalledFrom = info.installedFrom ?? info.worktree;
      if (existingInstalledFrom !== process.env.CURRENT_PROJECT_ROOT) {
        console.warn([
          "",
          "============================================================",
          "[install-dev] WARNING: 正在跨会话覆盖另一个 worktree 安装的开发包",
          `  branch/commit: 槽位原有 ${info.branch ?? "null"} @ ${info.commitShort ?? "null"} | 本次安装 ${process.env.INCOMING_BRANCH || "null"} @ ${process.env.INCOMING_COMMIT_SHORT || "null"}`,
          `  installedFrom: 槽位原有 ${existingInstalledFrom ?? "null"} | 本次安装 ${process.env.CURRENT_PROJECT_ROOT}`,
          `  槽位 builtAt: ${info.builtAt ?? "null"}`,
          "============================================================",
          "",
        ].join("\n"));
      }
    } catch (error) {
      console.warn(`[install-dev] 槽位里的 build-info.json 无法读取，将继续覆盖：${error.message}`);
    }
  ' || echo "[install-dev] 无法检查槽位 build-info，将继续覆盖"
}

write_build_info() {
  local installed_app="/Applications/$APP_NAME.app"
  local build_info="$installed_app/Contents/Resources/build-info.json"
  local branch
  local commit
  local commit_short
  local dirty
  local git_status
  local worktree

  branch="$(git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  commit="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || true)"
  commit_short="$(git -C "$PROJECT_ROOT" rev-parse --short=7 HEAD 2>/dev/null || true)"
  worktree="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
  if git_status="$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=normal 2>/dev/null)"; then
    if [ -n "$git_status" ]; then
      dirty="true"
    else
      dirty="false"
    fi
  else
    dirty=""
  fi

  BUILD_INFO_PATH="$build_info" \
  BUILD_APP_NAME="$APP_NAME" \
  BUILD_BRANCH="$branch" \
  BUILD_COMMIT="$commit" \
  BUILD_COMMIT_SHORT="$commit_short" \
  BUILD_DIRTY="$dirty" \
  BUILD_WORKTREE="$worktree" \
  BUILD_INSTALLED_FROM="$PROJECT_ROOT" \
  node -e '
    const fs = require("fs");
    const nullable = (value) => value || null;
    const info = {
      appName: process.env.BUILD_APP_NAME,
      branch: nullable(process.env.BUILD_BRANCH),
      commit: nullable(process.env.BUILD_COMMIT),
      commitShort: nullable(process.env.BUILD_COMMIT_SHORT),
      dirty: process.env.BUILD_DIRTY === "" ? null : process.env.BUILD_DIRTY === "true",
      worktree: nullable(process.env.BUILD_WORKTREE),
      installedFrom: nullable(process.env.BUILD_INSTALLED_FROM),
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(process.env.BUILD_INFO_PATH, `${JSON.stringify(info, null, 2)}\n`);
  '
}

# 只关掉**本槽**的测试包实例，不碰生产、也不碰别的槽。
# 别用 `pkill -f "$APP_NAME"`：槽 1 的名字 "Agent Neo Dev" 是槽 2 "Agent Neo Dev 2" 的前缀，
# 装槽 1 会顺手杀掉别人正在验的槽 2。带上 .app/Contents/MacOS/ 让两者不再互相命中。
pkill -f "$APP_NAME.app/Contents/MacOS/" 2>/dev/null || true
sleep 1

SOURCE_APP="$BUNDLE_DIR/macos/$APP_NAME.app"
if [ ! -d "$SOURCE_APP" ]; then
  echo "Error: $SOURCE_APP not found（先跑 npm run tauri:package:dev）"
  exit 1
fi

strip_local_secrets "$SOURCE_APP"
warn_about_existing_install
rm -rf "/Applications/$APP_NAME.app"
cp -R "$SOURCE_APP" "/Applications/$APP_NAME.app"
strip_local_secrets "/Applications/$APP_NAME.app"
write_build_info
resign_app_if_possible "/Applications/$APP_NAME.app"
INSTALLED_RESOURCES_ROOT="$(resolve_tauri_app_resources_root "/Applications/$APP_NAME.app")"
node "$PROJECT_ROOT/scripts/release-security-scan.mjs" "$INSTALLED_RESOURCES_ROOT"
bash "$PROJECT_ROOT/scripts/verify-tauri-dev-app.sh" "/Applications/$APP_NAME.app"
echo "Installed to /Applications/$APP_NAME.app"
mdimport "/Applications/$APP_NAME.app" 2>/dev/null || true

# 清理构建产物里的 .app（避免 Spotlight 索引到重复），仅清测试包
unregister_dev() { [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$SOURCE_APP" >/dev/null 2>&1 || true; }
unregister_dev
rm -rf "$SOURCE_APP" "$SOURCE_APP.tar.gz"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "/Applications/$APP_NAME.app" >/dev/null 2>&1 || true

# webServer 优先 serve <数据目录>/renderer-cache/active（云端热更新的 bundle）：改了 renderer
# 重装后不清缓存看到的还是旧版。这里只清**本槽**的 active，不碰整个 renderer-cache、更不碰
# 数据目录里的其他东西。槽名不在 shell 里另算，从 .dev-slot.json 读。
DEV_DATA_DIR_NAME="$(read_slot_field dataDirName)" || exit 1
rm -rf "$HOME/$DEV_DATA_DIR_NAME/renderer-cache/active"
echo "[install-dev] 已清本槽热更新缓存 ~/$DEV_DATA_DIR_NAME/renderer-cache/active"

echo "Done. 测试包独立运行（数据目录 ~/$DEV_DATA_DIR_NAME）：open '/Applications/$APP_NAME.app'"
