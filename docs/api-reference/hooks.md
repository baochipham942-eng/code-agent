# Hooks System API Reference

> **Status**: active in v0.16.74. Hooks run in app, web/CLI-backed AgentLoop paths, and CLI mode now enables hooks by default.

## Overview

Hooks let users run command, prompt, agent, or HTTP automation around agent lifecycle events. They support two modes:

| Mode | Behavior |
|------|----------|
| `decision` | Can block or modify the current action when the event supports it |
| `observer` | Runs for logging/notification/analytics; block or modify results are ignored |

Trigger history is kept in memory for the latest 50 entries. Chat turn timeline consumes that history as `hook_activity`, so the user can see which hooks ran, whether any blocked, whether input was modified, and how long they took.

## Configuration

Preferred config files:

| Scope | Path | Shape |
|-------|------|-------|
| Global | `~/.code-agent/hooks/hooks.json` | direct `HooksConfig` object |
| Project | `<project>/.code-agent/hooks/hooks.json` | direct `HooksConfig` object |

Legacy `.claude/settings.json` with `{ "hooks": ... }` is still read at lower priority. If both new and legacy files exist at the same scope, the `.code-agent/hooks/hooks.json` file wins.

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hookType": "decision",
      "hooks": [
        {
          "type": "command",
          "command": "./scripts/validate-command.sh",
          "timeout": 5000
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "*",
      "hookType": "observer",
      "parallel": true,
      "hooks": [
        {
          "type": "http",
          "url": "https://example.internal/hooks/tool",
          "timeout": 3000
        }
      ]
    }
  ]
}
```

## Hook Definition

| Field | Type | Notes |
|-------|------|-------|
| `type` | `command` / `prompt` / `agent` / `http` | Required |
| `command` | string | Required for command hooks |
| `prompt` | string | Required for prompt hooks |
| `agent` | string | Required for agent hooks |
| `agentPrompt` | string | Optional agent hook prompt |
| `url` | string | Required for HTTP hooks |
| `headers` | object | HTTP headers; env interpolation must be allowlisted |
| `allowedEnvVars` | string[] | Env vars available for HTTP header interpolation |
| `timeout` | number | Defaults to 5000ms |
| `async` | boolean | Fire-and-forget |
| `once` | boolean | Run once per session |
| `if` | string | Conditional tool input matcher, for example `Bash(git *)` |

Matcher fields:

| Field | Type | Notes |
|-------|------|-------|
| `matcher` | regex string or `*` | Tool matcher for tool events |
| `mcpServer` | string | Matches tools named `mcp__<server>__*` |
| `parallel` | boolean | Runs hooks in the same matcher group concurrently |
| `hookType` | `decision` / `observer` | Observer-only events force observer mode |

## Events

Code Agent currently defines 19 hook events.

| Stability | Events |
|-----------|--------|
| Stable | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `PostExecution`, `PreCompact`, `SessionStart`, `SessionEnd`, `SubagentStop` |
| Experimental | `SubagentStart`, `PermissionRequest`, `TaskCreated`, `TaskCompleted`, `PermissionDenied`, `PostCompact`, `StopFailure` |
| Internal legacy | `Setup`, `Notification` |

Observer-only events: `PostToolUse`, `PostToolUseFailure`, `PostExecution`, `SessionStart`, `SessionEnd`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PermissionDenied`, `PostCompact`, `StopFailure`. If configured as `decision`, they are downgraded to `observer`.

## Result Contract

```ts
type HookActionResult = 'allow' | 'block' | 'continue' | 'error';

interface HookExecutionResult {
  action: HookActionResult;
  message?: string;
  modifiedInput?: string;
  duration: number;
  error?: string;
}
```

Aggregated trigger result:

```ts
interface HookTriggerResult {
  shouldProceed: boolean;
  message?: string;
  modifiedInput?: string;
  results: HookExecutionResult[];
  totalDuration: number;
}
```

## Environment Variables

Command hooks receive event context through `HOOK_*` variables.

| Variable | Description |
|----------|-------------|
| `HOOK_SESSION_ID` | Current session id |
| `HOOK_EVENT` | Hook event name |
| `HOOK_TOOL_NAME` | Tool name for tool events |
| `HOOK_TOOL_INPUT` | JSON/stringified tool input |
| `HOOK_TOOL_OUTPUT` | Tool output for `PostToolUse` |
| `HOOK_ERROR_MESSAGE` | Error message for failure events |
| `HOOK_WORKING_DIR` | Working directory |
| `HOOK_USER_PROMPT` | User prompt for `UserPromptSubmit` |

## IPC Surface

`domain:hook` exposes the management surface used by Settings.

| Action | Payload | Response |
|--------|---------|----------|
| `list` | none | enabled hooks, unused events, global/project config paths |
| `openConfigFile` | `{ filePath: string }` | creates an empty hooks template if missing, opens it |
| `revealConfigFolder` | `{ filePath: string }` | reveals the file in Finder |

The settings tab is `src/renderer/components/features/settings/tabs/HooksSettings.tsx`.

## Runtime Path

```
AgentLoop
  -> HookManager.initialize()
  -> triggerPreToolUse / triggerPostToolUse / triggerUserPromptSubmit / ...
  -> hookExecutionEngine.executeHooks()
  -> command / prompt / agent / http executor
  -> HookManager.recordTrigger()
  -> turn timeline hook_activity
  -> TurnCard HookExecutionBanner
```

Key files:

| File | Role |
|------|------|
| `src/main/hooks/configParser.ts` | Reads new and legacy config files, validates hooks, downgrades observer-only events |
| `src/main/hooks/merger.ts` | Merges global/project hooks by append/replace/prepend strategy |
| `src/main/hooks/hookExecutionEngine.ts` | Executes hooks, handles once/async/parallel/observer semantics |
| `src/main/hooks/hookManager.ts` | Lifecycle API, trigger history, UI observer callback |
| `src/main/ipc/hook.ipc.ts` | Settings-facing summary and config file actions |
| `src/renderer/components/features/chat/TurnCard.tsx` | Chat hook activity banner |
