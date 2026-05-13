#!/usr/bin/env bash
# ============================================================================
# 安装 Code Agent MCP server 到稳定路径
# ============================================================================
# 把 dist/mcp-server.js 软链到 ~/.code-agent/bin/mcp-server.js，
# 这样 Claude Code 等 MCP 客户端就可以引用一个跟项目源码目录解耦的路径。
# 重新 npm run build:mcp-server 后，软链自动指向新的 bundle。
#
# 用法:
#   npm run build:mcp-server   # 先构建
#   bash scripts/install-mcp-server.sh
#
# 之后在 ~/.claude.json 加（路径用稳定的安装位置）:
#   "code-agent": {
#     "command": "node",
#     "args": ["~/.code-agent/bin/mcp-server.js" 替换成绝对路径]
#   }
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE="$PROJECT_ROOT/dist/mcp-server.js"
INSTALL_DIR="$HOME/.code-agent/bin"
INSTALL_PATH="$INSTALL_DIR/mcp-server.js"

if [[ ! -f "$BUNDLE" ]]; then
  echo "❌ 找不到 bundle: $BUNDLE" >&2
  echo "   先跑: npm run build:mcp-server" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
ln -sf "$BUNDLE" "$INSTALL_PATH"

echo "✓ 已安装 MCP server"
echo "  bundle:  $BUNDLE"
echo "  symlink: $INSTALL_PATH"
echo ""
echo "在 ~/.claude.json 的 mcpServers 加："
echo '  "code-agent": {'
echo '    "command": "node",'
echo "    \"args\": [\"$INSTALL_PATH\"]"
echo '  }'
echo ""
echo "然后重启 Claude Code 会话生效。"
