#!/bin/bash
# ============================================================================
# rebuild-native.sh - 重新编译 Electron 原生模块
# ============================================================================
# 使用方法: npm run rebuild-native
#
# 问题背景:
# - Electron 使用自己的 Node.js 版本，与系统 Node.js 版本不同
# - 原生模块 (isolated-vm, better-sqlite3, keytar) 必须用 Electron 的 ABI 编译
# - npm install 默认用系统 Node.js 编译，导致 NODE_MODULE_VERSION 不匹配
#
# 触发场景:
# - 运行 npm install 后
# - 切换 Node.js 版本后
# - 更新 Electron 版本后
# - 打包前（必须！）
# ============================================================================

set -e

echo "🔧 重新编译 Electron 原生模块..."
echo ""

# 获取项目根目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# 读取实际安装的 Electron 版本（从 node_modules）
ELECTRON_VERSION=$(node -p "require('./node_modules/electron/package.json').version")
echo "📦 Electron 版本: $ELECTRON_VERSION"
echo "📦 项目目录: $PROJECT_ROOT"
echo ""

# 原生模块列表（逐个安装以避免并发编译问题）
NATIVE_MODULES=(isolated-vm better-sqlite3 keytar node-pty)

# 逐个重新编译
for module in "${NATIVE_MODULES[@]}"; do
  echo "🔨 重新编译 $module..."

  # 删除现有模块
  rm -rf "node_modules/$module"

  # 重新安装并编译
  npm install "$module" \
    --build-from-source \
    --runtime=electron \
    --target="$ELECTRON_VERSION" \
    --disturl=https://electronjs.org/headers \
    --silent

  echo "   ✅ $module 完成"
done

echo ""
echo "✅ 原生模块编译完成!"
echo ""
echo "下一步:"
echo "  开发模式: npm run dev"
echo "  打包应用: npm run dist:mac"
