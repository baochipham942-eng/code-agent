#!/bin/bash
# ============================================================================
# run-dev-slot.sh — 构建 + 安装 + 启动 Dev 测试包的唯一入口
# ============================================================================
# 为什么存在：禁止直接 exec *.app/Contents/MacOS/code-agent-tauri。从 agent
# 沙箱（Codex desktop seatbelt 等）直接拉起 GUI 二进制必崩——拿不到
# WindowServer，AppKit 在 _RegisterApplication 里 abort，弹系统崩溃报告
# （2026-09-25 实录连崩三次）。GUI app 只能经 LaunchServices 以 open 启动，
# 目标必须是 /Applications 里装好签好的槽。
#
# 用法：
#   bash scripts/run-dev-slot.sh [N]             # NEO_SLOT=N（缺省 1）构建+安装+启动
#   bash scripts/run-dev-slot.sh [N] --open-only # 不构建，只拉起已装的槽 N
#
# 注意：agent 沙箱可能连 `open` 都拦（要和 launchd 通信）。open 失败时把脚本
# 末尾打出的那条命令交回用户终端执行，别在沙箱里重试。
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SLOT_META="$PROJECT_ROOT/src-tauri/.dev-slot.json"

SLOT="1"
OPEN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --open-only) OPEN_ONLY=1 ;;
    [1-9]) SLOT="$arg" ;;
    *) echo "Usage: bash scripts/run-dev-slot.sh [NEO_SLOT 1-9] [--open-only]" >&2; exit 1 ;;
  esac
done

# --open-only 没有刚生成的 .dev-slot.json 可读（它反映的是上一次构建的槽），
# 这里按 src/shared/devSlot.ts 钉死的规则拼槽名：槽 1 无后缀，槽 N 是 " N"。
app_name_for_slot() {
  if [ "$1" = "1" ]; then
    printf 'Agent Neo Dev'
  else
    printf 'Agent Neo Dev %s' "$1"
  fi
}

if [ "$OPEN_ONLY" = "0" ]; then
  cd "$PROJECT_ROOT"
  # tauri:build:dev = tauri:package:dev + tauri-install-dev.sh，装完会删掉
  # target/ 里的中间 .app 并向 LaunchServices 注册 /Applications 里的槽。
  NEO_SLOT="$SLOT" npm run tauri:build:dev

  # 槽名与端口从 gen-dev-slot-conf 写出的元数据读，不在 shell 里再实现一遍
  # 后缀规则（同 tauri-install-dev.sh 的理由：两处各算一遍换槽时会错开）。
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
  APP_NAME="$(read_slot_field productName)"
  WEB_PORT="$(read_slot_field webPort)"
else
  APP_NAME="$(app_name_for_slot "$SLOT")"
  WEB_PORT=$((8180 + SLOT))
  if [ ! -d "/Applications/$APP_NAME.app" ]; then
    echo "Error: /Applications/$APP_NAME.app 不存在（先不带 --open-only 跑一遍构建+安装）" >&2
    exit 1
  fi
fi

APP_PATH="/Applications/$APP_NAME.app"
echo "[run-dev-slot] 启动 $APP_PATH"
if ! open "$APP_PATH"; then
  echo "[run-dev-slot] open 失败——如果你正在 agent 沙箱里，把这条命令交回用户终端执行：" >&2
  echo "  open '$APP_PATH'" >&2
  exit 1
fi

echo "[run-dev-slot] 已启动。判定跑在新包上："
echo "  curl -s http://127.0.0.1:${WEB_PORT}/ | grep -oE 'assets/index-[^\"]*\\.js'"
echo "  与 app 内 dist/renderer/index.html 引用一致才算。"
