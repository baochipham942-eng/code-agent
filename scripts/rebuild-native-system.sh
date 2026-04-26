#!/bin/bash
# ============================================================================
# rebuild-native-system.sh - 为系统 Node.js 重新编译原生模块
# ============================================================================
# 使用方法: npm run rebuild-native:system
#
# 问题背景:
# - Tauri app 通过系统 Node.js 运行 webServer.cjs
# - postinstall 默认用 Electron ABI 编译 better-sqlite3
# - 系统 Node.js 加载 Electron ABI 的 .node 文件会失败
#
# 解决方案:
# - 为系统 Node 单独编译 better-sqlite3 到 dist/native/
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

echo "Rebuilding better-sqlite3@$BETTER_SQLITE3_VERSION for system Node.js ($NODE_VERSION)..."

# 在临时目录编译，避免污染 node_modules（那里是 Electron 版本）
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cd "$TEMP_DIR"
npm init -y --silent > /dev/null 2>&1
npm install "better-sqlite3@$BETTER_SQLITE3_VERSION" --build-from-source --silent 2>&1 | tail -1

# 复制编译产物到 dist/native/
rm -rf "$NATIVE_DIR"
mkdir -p "$NATIVE_DIR/build/Release"
cp "$TEMP_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
   "$NATIVE_DIR/build/Release/better_sqlite3.node"

# 复制 JS 入口文件（require 需要）
cp -r "$TEMP_DIR/node_modules/better-sqlite3/lib" "$NATIVE_DIR/lib"
cp "$TEMP_DIR/node_modules/better-sqlite3/package.json" "$NATIVE_DIR/package.json"

# 复制运行时依赖到 node_modules 布局，保证 Tauri resource_dir 里也能正常 require()
rm -rf "$NATIVE_NODE_MODULES/bindings" \
       "$NATIVE_NODE_MODULES/file-uri-to-path" \
       "$PROJECT_ROOT/dist/native/bindings" \
       "$PROJECT_ROOT/dist/native/file-uri-to-path"
mkdir -p "$NATIVE_NODE_MODULES"
if [ -d "$TEMP_DIR/node_modules/bindings" ]; then
  cp -r "$TEMP_DIR/node_modules/bindings" "$NATIVE_NODE_MODULES/bindings"
fi
if [ -d "$TEMP_DIR/node_modules/file-uri-to-path" ]; then
  cp -r "$TEMP_DIR/node_modules/file-uri-to-path" "$NATIVE_NODE_MODULES/file-uri-to-path"
fi

echo "Done! Native module at: dist/native/better-sqlite3/"
echo "  .node file: $(file "$NATIVE_DIR/build/Release/better_sqlite3.node")"
