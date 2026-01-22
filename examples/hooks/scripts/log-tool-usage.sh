#!/bin/bash
# log-tool-usage.sh
# PostToolUse hook to log all tool executions

LOG_FILE="${HOME}/.code-agent/custom-tool-log.jsonl"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create log directory if needed
mkdir -p "$(dirname "$LOG_FILE")"

# Write log entry
echo "{\"timestamp\":\"$TIMESTAMP\",\"sessionId\":\"$SESSION_ID\",\"tool\":\"$TOOL_NAME\",\"input\":$TOOL_INPUT}" >> "$LOG_FILE"

exit 0
