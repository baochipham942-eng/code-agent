#!/bin/bash
# ============================================================================
# rebuild-native-cli.sh - 为 Node.js CLI 模式重新编译原生模块
# ============================================================================
# 使用方法: npm run rebuild-native:cli
#
# 问题背景:
# - postinstall 会把 better-sqlite3 编译为 Electron ABI (NODE_MODULE_VERSION 139)
# - CLI 模式用系统 Node.js 运行 (NODE_MODULE_VERSION 127)，ABI 不匹配
# - 此脚本为系统 Node.js 额外编译一份 .node，保存为 better_sqlite3_cli.node
# - CLI 代码通过 nativeBinding 选项加载这个文件
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

RELEASE_DIR="node_modules/better-sqlite3/build/Release"
CLI_BINARY="$RELEASE_DIR/better_sqlite3_cli.node"
ELECTRON_BINARY="$RELEASE_DIR/better_sqlite3.node"

NODE_ABI=$(node -p "process.versions.modules")
echo "Building better-sqlite3 for Node.js (ABI $NODE_ABI)..."

# 如果 CLI binary 已存在且 ABI 匹配，跳过重新编译
if [ -f "$CLI_BINARY" ]; then
  if node -e "
    const BS3 = require('better-sqlite3');
    const db = new BS3(':memory:', { nativeBinding: '$CLI_BINARY' });
    db.close();
  " 2>/dev/null; then
    echo "CLI binary already exists and is compatible, skipping rebuild."
    exit 0
  fi
fi

# 备份 Electron binary 到临时目录（node-gyp rebuild 会清空 build/）
BACKUP_DIR=$(mktemp -d)
if [ -f "$ELECTRON_BINARY" ]; then
  cp "$ELECTRON_BINARY" "$BACKUP_DIR/better_sqlite3_electron.node"
  echo "Backed up Electron binary to $BACKUP_DIR"
fi

# 用系统 Node.js 重新编译
cd node_modules/better-sqlite3
npx --yes node-gyp rebuild --release 2>&1 | tail -3

cd "$PROJECT_ROOT"

# 将新编译的 Node.js binary 保存为 CLI 专用
cp "$ELECTRON_BINARY" "$CLI_BINARY"

# 恢复 Electron binary
if [ -f "$BACKUP_DIR/better_sqlite3_electron.node" ]; then
  cp "$BACKUP_DIR/better_sqlite3_electron.node" "$ELECTRON_BINARY"
  echo "Restored Electron binary"
fi

# 清理临时目录
rm -rf "$BACKUP_DIR"

echo "CLI binary saved to: $CLI_BINARY"
echo "Done."
