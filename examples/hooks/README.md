# Hooks Configuration Examples

This directory contains example configurations and scripts for the Code Agent hooks system.

## Files

- `hooks-config.json` - Complete hooks configuration example
- `scripts/` - Example hook scripts
  - `validate-command.sh` - PreToolUse validation for Bash commands
  - `log-tool-usage.sh` - PostToolUse logging
  - `session-init.sh` - SessionStart initialization
  - `session-cleanup.sh` - SessionEnd cleanup

## Setup

1. Copy the `scripts/` directory to your project root
2. Make scripts executable:
   ```bash
   chmod +x scripts/*.sh
   ```
3. Copy hook configuration to `.claude/settings.json`

## Event Types

| Event | When It Fires | Common Use Cases |
|-------|---------------|------------------|
| `PreToolUse` | Before tool execution | Validation, blocking |
| `PostToolUse` | After successful execution | Logging, notifications |
| `PostToolUseFailure` | After failed execution | Error handling |
| `UserPromptSubmit` | When user sends message | Input validation |
| `SessionStart` | Session begins | Environment setup |
| `SessionEnd` | Session ends | Cleanup, reporting |
| `Stop` | Agent stops | Final cleanup |
| `SubagentStop` | Subagent stops | Subagent cleanup |
| `PreCompact` | Before context compaction | State preservation |
| `Setup` | During initialization | Global setup |
| `Notification` | For notifications | Alerts, webhooks |

## Environment Variables

Scripts receive these environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `TOOL_NAME` | Tool being used | `Bash`, `Write`, `Edit` |
| `TOOL_INPUT` | JSON input to tool | `{"command":"ls"}` |
| `SESSION_ID` | Current session ID | `sess_abc123` |
| `FILE_PATH` | File path (file ops) | `/path/to/file.ts` |
| `COMMAND` | Command (Bash only) | `npm test` |

## Script Return Codes

- **Exit 0**: Allow the operation to proceed
- **Exit non-zero**: Block the operation

## Example: Custom Command Validation

```bash
#!/bin/bash
# my-validator.sh

COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command')

# Block commands that modify production
if [[ "$COMMAND" == *"production"* ]]; then
  echo "BLOCKED: Cannot modify production" >&2
  exit 1
fi

exit 0
```

## Example: Slack Notification

```bash
#!/bin/bash
# notify-slack.sh

SLACK_WEBHOOK="https://hooks.slack.com/services/xxx"

curl -X POST "$SLACK_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"Tool $TOOL_NAME executed in session $SESSION_ID\"}"

exit 0
```

## Debugging

Enable verbose logging:

```bash
#!/bin/bash
set -x  # Print commands as they execute

# Your script logic here
```

Check hook execution in Code Agent logs:
```bash
tail -f ~/.code-agent/logs/main.log | grep hook
```
