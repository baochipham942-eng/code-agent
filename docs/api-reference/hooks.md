# Hooks System API Reference

> **Status**: SCAFFOLD - Will be completed when Session C finishes C9-C14

This document describes the Hooks system APIs for Code Agent.

## Overview

The Hooks system allows users to configure custom actions that execute in response to agent events. Hooks can run shell commands, execute scripts, or use AI-based evaluation.

## Event Types

Code Agent supports 11 hook event types:

| Event | Trigger | Use Case |
|-------|---------|----------|
| `PreToolUse` | Before tool execution | Validate/block commands |
| `PostToolUse` | After successful tool execution | Log, notify |
| `PostToolUseFailure` | After failed tool execution | Error handling |
| `UserPromptSubmit` | When user submits prompt | Input validation |
| `Stop` | When agent stops | Cleanup tasks |
| `SubagentStop` | When subagent stops | Subagent cleanup |
| `PreCompact` | Before context compaction | Save state |
| `Setup` | During initialization | Configure environment |
| `SessionStart` | When session begins | Initialize resources |
| `SessionEnd` | When session ends | Final cleanup |
| `Notification` | For notifications | Alert systems |

---

## Configuration

### Configuration File Location

Hooks are configured in `.claude/settings.json`:

- **Global**: `~/.claude/settings.json`
- **Project**: `<project>/.claude/settings.json`

Project-level hooks are merged with global hooks.

### Configuration Schema

```json
{
  "hooks": {
    "<EventType>": [
      {
        "matcher": "<ToolPattern>",
        "hooks": [
          {
            "type": "command",
            "command": "<shell command>",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

### Example Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/validate-command.sh",
            "timeout": 5000
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'File operation: $TOOL_NAME on $FILE_PATH'"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/log-tool-usage.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/cleanup.sh"
          }
        ]
      }
    ]
  }
}
```

---

## Modules

### Config Parser (`src/main/hooks/configParser.ts`)

Parses and validates hook configuration.

```typescript
// TODO: Document when C9 is complete
interface HookConfigParser {
  parse(config: unknown): HookConfig;
  validate(config: HookConfig): ValidationResult;
  merge(global: HookConfig, project: HookConfig): HookConfig;
}

interface HookConfig {
  hooks: Record<EventType, HookMatcher[]>;
}

interface HookMatcher {
  matcher: string;  // Regex pattern
  hooks: HookDefinition[];
}

interface HookDefinition {
  type: 'command' | 'prompt';
  command?: string;
  prompt?: string;
  timeout?: number;
}
```

---

### Script Executor (`src/main/hooks/scriptExecutor.ts`)

Executes external scripts with environment variables.

```typescript
// TODO: Document when C10 is complete
interface ScriptExecutor {
  execute(command: string, env: HookEnvironment): Promise<ExecutionResult>;
}

interface HookEnvironment {
  TOOL_NAME: string;
  TOOL_INPUT: string;
  SESSION_ID: string;
  FILE_PATH?: string;
  COMMAND?: string;
  // Additional context variables
}

interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
```

#### Environment Variables

Scripts receive these environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `TOOL_NAME` | Name of the tool | `Bash` |
| `TOOL_INPUT` | JSON-encoded tool input | `{"command":"ls"}` |
| `SESSION_ID` | Current session ID | `sess_abc123` |
| `FILE_PATH` | File path (for file tools) | `/path/to/file.ts` |
| `COMMAND` | Command (for Bash) | `npm test` |

---

### Events (`src/main/hooks/events.ts`)

Defines all hook event types and their payloads.

```typescript
// TODO: Document when C11 is complete
type EventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'Setup'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification';

interface HookEvent {
  type: EventType;
  timestamp: number;
  sessionId: string;
  payload: EventPayload;
}

type EventPayload =
  | ToolUsePayload
  | PromptPayload
  | SessionPayload
  | NotificationPayload;

interface ToolUsePayload {
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}
```

---

### Hook Merger (`src/main/hooks/merger.ts`)

Merges hooks from multiple configuration sources.

```typescript
// TODO: Document when C12 is complete
interface HookMerger {
  merge(configs: HookConfig[]): HookConfig;
}
```

#### Merge Rules

1. **Priority**: Project hooks run before global hooks
2. **Deduplication**: Identical hooks are deduplicated
3. **Ordering**: Hooks execute in definition order within each level

---

### Prompt-Based Hook (`src/main/hooks/promptHook.ts`)

Uses AI evaluation for complex hook decisions.

```typescript
// TODO: Document when C13 is complete
interface PromptHook {
  evaluate(event: HookEvent, prompt: string): Promise<HookDecision>;
}

type HookDecision = 'allow' | 'block' | 'continue';
```

#### Prompt Hook Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if this command is safe to execute: $COMMAND. Consider security implications. Respond with ALLOW, BLOCK, or CONTINUE.",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

---

### Hooks Engine (`src/main/planning/hooksEngine.ts`)

Main engine that orchestrates hook execution.

```typescript
// TODO: Document when C14 is complete
interface HooksEngine {
  trigger(event: HookEvent): Promise<HookResult>;
  register(eventType: EventType, hook: HookHandler): void;
  unregister(eventType: EventType, hookId: string): void;
}

interface HookResult {
  allowed: boolean;
  results: IndividualHookResult[];
}

interface IndividualHookResult {
  hookId: string;
  success: boolean;
  output?: string;
  error?: string;
  decision?: HookDecision;
}
```

---

## Hook Execution Flow

```
┌─────────────────┐
│  Event Occurs   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Load Config    │◄── Global + Project hooks
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Match Hooks    │◄── Filter by event type + matcher pattern
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Execute Hooks   │◄── In order, with environment
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Collect Results │◄── Aggregate decisions
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Return Decision │◄── allow / block / continue
└─────────────────┘
```

---

## Writing Hook Scripts

### Basic Script Template

```bash
#!/bin/bash
# validate-command.sh

# Environment variables are available
echo "Tool: $TOOL_NAME"
echo "Input: $TOOL_INPUT"
echo "Session: $SESSION_ID"

# Parse command for Bash tools
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command')

  # Block dangerous commands
  if [[ "$COMMAND" =~ "rm -rf /" ]]; then
    echo "BLOCKED: Dangerous command" >&2
    exit 1
  fi
fi

# Exit 0 to allow, non-zero to block
exit 0
```

### Script with Logging

```bash
#!/bin/bash
# log-tool-usage.sh

LOG_FILE="$HOME/.code-agent/tool-usage.log"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "$TIMESTAMP | $SESSION_ID | $TOOL_NAME | $TOOL_INPUT" >> "$LOG_FILE"
exit 0
```

---

## See Also

- [Hooks Test Scaffolds](../../tests/unit/hooks/) (when created)
- [Planning Module](../../src/main/planning/)
