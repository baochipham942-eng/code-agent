#!/bin/bash
# session-cleanup.sh
# SessionEnd hook to clean up session resources

echo "Session $SESSION_ID ending at $(date)"

# Example: Clean up session temp directory
SESSION_TEMP="${TMPDIR:-/tmp}/code-agent-$SESSION_ID"
if [ -d "$SESSION_TEMP" ]; then
  rm -rf "$SESSION_TEMP"
  echo "Cleaned up session temp directory"
fi

# Example: Send notification
# curl -X POST "https://your-webhook.com/session-end" \
#   -H "Content-Type: application/json" \
#   -d "{\"sessionId\":\"$SESSION_ID\",\"endTime\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"

exit 0
