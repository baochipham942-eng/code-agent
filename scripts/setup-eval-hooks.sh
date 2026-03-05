#!/bin/bash
# ============================================================================
# setup-eval-hooks.sh — Installs git hooks for eval-driven development
# ============================================================================
#
# Installs a pre-push hook that runs smoke eval tests before pushing.
# Usage: bash scripts/setup-eval-hooks.sh

set -euo pipefail

HOOKS_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
HOOK_FILE="${HOOKS_DIR}/pre-push"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: .git/hooks directory not found. Are you in a git repo?"
  exit 1
fi

# Back up existing hook if present
if [ -f "$HOOK_FILE" ]; then
  BACKUP="${HOOK_FILE}.backup.$(date +%s)"
  echo "Backing up existing pre-push hook to ${BACKUP}"
  cp "$HOOK_FILE" "$BACKUP"
fi

cat > "$HOOK_FILE" << 'HOOK'
#!/bin/bash
# Pre-push hook: run eval smoke tests
# Installed by scripts/setup-eval-hooks.sh

echo "Running eval smoke tests before push..."
npx tsx scripts/eval-ci.ts --scope smoke

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "Eval smoke tests failed. Push aborted."
  echo "Run 'npx tsx scripts/eval-ci.ts --scope smoke' to see details."
  exit 1
fi
HOOK

chmod +x "$HOOK_FILE"
echo "Pre-push hook installed at ${HOOK_FILE}"
echo "Smoke eval tests will run automatically before each push."
