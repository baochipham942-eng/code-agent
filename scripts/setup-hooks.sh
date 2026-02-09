#!/usr/bin/env bash
# =============================================================================
# setup-hooks.sh — 安装 Git pre-commit hook
# 一次性运行：bash scripts/setup-hooks.sh
# =============================================================================

set -euo pipefail

HOOK_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"

if [[ -f "$HOOK_FILE" ]]; then
  echo "⚠️  已存在 pre-commit hook: $HOOK_FILE"
  echo "   将在末尾追加模型名检查..."
  echo "" >> "$HOOK_FILE"
  echo "# 模型名称新鲜度检查" >> "$HOOK_FILE"
  echo 'bash scripts/check-hardcoded-models.sh' >> "$HOOK_FILE"
else
  cat > "$HOOK_FILE" << 'EOF'
#!/usr/bin/env bash
# Auto-generated pre-commit hook

# 模型名称新鲜度检查
bash scripts/check-hardcoded-models.sh
EOF
  chmod +x "$HOOK_FILE"
fi

echo "✅ pre-commit hook 已安装: $HOOK_FILE"
