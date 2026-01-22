#!/bin/bash
# session-init.sh
# SessionStart hook to initialize session environment

echo "Session $SESSION_ID starting at $(date)"

# Example: Set up session-specific temp directory
SESSION_TEMP="${TMPDIR:-/tmp}/code-agent-$SESSION_ID"
mkdir -p "$SESSION_TEMP"

# Example: Initialize session log
echo "Session started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$SESSION_TEMP/session.log"

# Example: Load project-specific environment
if [ -f ".env.local" ]; then
  echo "Loading project environment from .env.local"
fi

exit 0
