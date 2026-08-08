#!/bin/bash
# ============================================================================
# rebuild-native-system.sh - 为系统 Node.js 准备原生模块
# ============================================================================
# 使用方法: npm run rebuild-native:system
#
# 问题背景:
# - Tauri app 通过 bundled/system Node.js 运行 webServer.cjs
# - better-sqlite3 v13 使用 Node-API，并随包提供跨 Node ABI 的平台预编译文件
# - 打包态仍需要把当前平台文件复制到 dist/native/，供 nativeLoader 优先加载
#
# 解决方案:
# - 把当前平台的 better-sqlite3 Node-API 预编译文件装配到 dist/native/
# - webServer.cjs 运行时优先从 dist/native/ 加载
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

NATIVE_DIR="$PROJECT_ROOT/dist/native/better-sqlite3"
NATIVE_NODE_MODULES="$PROJECT_ROOT/dist/native/node_modules"
NODE_VERSION=$(node -v)
BETTER_SQLITE3_VERSION=$(node - <<'NODE'
const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const entry = lock.packages?.['node_modules/better-sqlite3'];
if (!entry?.version) {
  throw new Error('package-lock.json is missing node_modules/better-sqlite3');
}
process.stdout.write(entry.version);
NODE
)

echo "Preparing better-sqlite3@$BETTER_SQLITE3_VERSION for system Node.js ($NODE_VERSION)..."

# 在临时目录按 lockfile 版本取干净包，避免依赖工作区 node_modules 的残留产物。
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
NPM_CACHE_DIR="$TEMP_DIR/npm-cache"

cd "$TEMP_DIR"
npm init -y --silent > /dev/null 2>&1
NPM_INSTALL_LOG="$TEMP_DIR/npm-install.log"
# 不加 --silent：npm 在 --silent 下会连 ECONNREFUSED 等失败信息一起吞掉（实测验证），
# 靠这里的日志文件 + 分支输出来控制"成功时克制、失败时完整"，而不是靠 npm 自己的 loglevel。
if ! npm install "better-sqlite3@$BETTER_SQLITE3_VERSION" --ignore-scripts --cache "$NPM_CACHE_DIR" > "$NPM_INSTALL_LOG" 2>&1; then
  echo "npm install 失败，完整日志：" >&2
  cat "$NPM_INSTALL_LOG" >&2
  exit 1
fi
tail -1 "$NPM_INSTALL_LOG"

# v13 的预编译文件名直接编码平台和架构；Linux 还要区分 glibc / musl。
PREBUILD_BASENAME=$(node - <<'NODE'
const isMusl = process.platform === 'linux'
  && !process.report.getReport().header.glibcVersionRuntime;
const platform = isMusl ? 'linuxmusl' : process.platform;
process.stdout.write(`${platform}-${process.arch}.node`);
NODE
)
PREBUILD_SOURCE="$TEMP_DIR/node_modules/better-sqlite3/prebuilds/$PREBUILD_BASENAME"
if [ ! -f "$PREBUILD_SOURCE" ]; then
  echo "better-sqlite3 缺少当前平台预编译文件: $PREBUILD_SOURCE" >&2
  exit 1
fi

# 复制当前平台运行时到 dist/native/。
rm -rf "$NATIVE_DIR"
mkdir -p "$NATIVE_DIR/prebuilds"
cp "$PREBUILD_SOURCE" "$NATIVE_DIR/prebuilds/$PREBUILD_BASENAME"
cp -r "$TEMP_DIR/node_modules/better-sqlite3/lib" "$NATIVE_DIR/lib"
cp "$TEMP_DIR/node_modules/better-sqlite3/package.json" "$NATIVE_DIR/package.json"

# v12 的 bindings/file-uri-to-path 已不再是 v13 运行时依赖，清掉历史装配残留。
rm -rf "$NATIVE_NODE_MODULES/bindings" \
       "$NATIVE_NODE_MODULES/file-uri-to-path" \
       "$PROJECT_ROOT/dist/native/bindings" \
       "$PROJECT_ROOT/dist/native/file-uri-to-path"
mkdir -p "$NATIVE_NODE_MODULES"

node - "$NATIVE_DIR" <<'NODE'
const Database = require(process.argv[2]);
const db = new Database(':memory:');
db.prepare('SELECT 1 AS ok').get();
db.close();
console.log(`[rebuild-native-system] better-sqlite3 Node-API smoke passed on ${process.version}`);
NODE

echo "Done! Native module at: dist/native/better-sqlite3/"
echo "  .node file: $(file "$NATIVE_DIR/prebuilds/$PREBUILD_BASENAME")"

# ----------------------------------------------------------------------------
# 恢复 node-pty prebuilt spawn-helper 的执行位
# ----------------------------------------------------------------------------
# npm 安装 node-pty 的 prebuilt 二进制后，spawn-helper 有时会丢失执行位（-rw-r--r--），
# 导致 PTY 启动报 posix_spawnp failed。release 打包路径（tauri-release-bundle.sh）会处理，
# 但 dev/install 路径不会。这里对所有 unix prebuilds（darwin-*/linux-*）的 spawn-helper
# 补 +x：幂等；缺失/Windows（无此文件）自然跳过。
PTY_PREBUILDS="$PROJECT_ROOT/node_modules/node-pty/prebuilds"
if [ -d "$PTY_PREBUILDS" ]; then
  pty_fixed=0
  while IFS= read -r -d '' helper; do
    chmod +x "$helper"
    pty_fixed=1
  done < <(find "$PTY_PREBUILDS" -name spawn-helper -type f -print0 2>/dev/null)
  if [ "$pty_fixed" = 1 ]; then
    echo "Restored +x on node-pty spawn-helper(s)"
  fi
fi
