#!/bin/bash
# validate-command.sh
# PreToolUse hook for Bash commands
# Exit 0 to allow, non-zero to block

set -e

# Parse the command from TOOL_INPUT JSON
COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty')

if [ -z "$COMMAND" ]; then
  echo "No command found in input"
  exit 0
fi

echo "Validating command: $COMMAND"

# Block dangerous patterns
DANGEROUS_PATTERNS=(
  "rm -rf /"
  "rm -rf /*"
  ":(){ :|:& };:"
  "dd if=/dev/zero"
  "> /dev/sda"
  "mkfs"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    echo "BLOCKED: Dangerous pattern detected: $pattern" >&2
    exit 1
  fi
done

# Warn on potentially risky patterns (but allow)
WARNING_PATTERNS=(
  "sudo"
  "chmod 777"
  "curl.*|.*sh"
  "wget.*|.*sh"
)

for pattern in "${WARNING_PATTERNS[@]}"; do
  if [[ "$COMMAND" =~ $pattern ]]; then
    echo "WARNING: Potentially risky pattern: $pattern" >&2
    # Still allow - exit 0
  fi
done

echo "Command validated successfully"
exit 0
