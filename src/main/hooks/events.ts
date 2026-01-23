// ============================================================================
// Hook Events - Define all hook event types
// Based on Claude Code v2.0 hook system
// ============================================================================

/**
 * All supported hook event types
 *
 * 11 event types covering the full lifecycle of agent interactions
 */
export type HookEvent =
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

/**
 * Event descriptions for documentation and UI
 */
export const HOOK_EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: 'Triggered before a tool is executed. Can block or modify the tool call.',
  PostToolUse: 'Triggered after a tool executes successfully.',
  PostToolUseFailure: 'Triggered when a tool execution fails.',
  UserPromptSubmit: 'Triggered when user submits a prompt, before processing.',
  Stop: 'Triggered when the agent is about to stop responding.',
  SubagentStop: 'Triggered when a subagent completes its task.',
  PreCompact: 'Triggered before context compaction/summarization.',
  Setup: 'Triggered once during initial setup of the session.',
  SessionStart: 'Triggered when a new session begins.',
  SessionEnd: 'Triggered when a session ends.',
  Notification: 'Triggered when a notification needs to be sent.',
};

/**
 * Hook execution result
 */
export type HookActionResult = 'allow' | 'block' | 'continue' | 'error';

/**
 * Context passed to hooks for each event type
 */
export interface HookEventContext {
  /** The event type */
  event: HookEvent;
  /** Session ID */
  sessionId: string;
  /** Timestamp of the event */
  timestamp: number;
  /** Working directory */
  workingDirectory: string;
}

/**
 * Context for tool-related events (PreToolUse, PostToolUse, PostToolUseFailure)
 */
export interface ToolHookContext extends HookEventContext {
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  /** Tool name */
  toolName: string;
  /** Tool input parameters (JSON string) */
  toolInput: string;
  /** Tool output (only for PostToolUse) */
  toolOutput?: string;
  /** Error message (only for PostToolUseFailure) */
  errorMessage?: string;
}

/**
 * Context for user prompt events
 */
export interface UserPromptContext extends HookEventContext {
  event: 'UserPromptSubmit';
  /** The user's prompt text */
  prompt: string;
}

/**
 * Context for stop events
 */
export interface StopContext extends HookEventContext {
  event: 'Stop' | 'SubagentStop';
  /** The agent's final response */
  response?: string;
  /** For SubagentStop: the subagent type */
  subagentType?: string;
}

/**
 * Context for session events
 */
export interface SessionContext extends HookEventContext {
  event: 'SessionStart' | 'SessionEnd' | 'Setup';
  /** Session metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context for compaction events
 */
export interface CompactContext extends HookEventContext {
  event: 'PreCompact';
  /** Current token count */
  tokenCount: number;
  /** Target token count after compaction */
  targetTokenCount: number;
}

/**
 * Context for notification events
 */
export interface NotificationContext extends HookEventContext {
  event: 'Notification';
  /** Notification type */
  notificationType: 'info' | 'warning' | 'error' | 'success';
  /** Notification message */
  message: string;
}

/**
 * Union type of all hook contexts
 */
export type AnyHookContext =
  | ToolHookContext
  | UserPromptContext
  | StopContext
  | SessionContext
  | CompactContext
  | NotificationContext;

/**
 * Result returned by a hook execution
 */
export interface HookExecutionResult {
  /** Whether the action should proceed */
  action: HookActionResult;
  /** Optional message to inject into context */
  message?: string;
  /** Modified input (for PreToolUse hooks that modify tool input) */
  modifiedInput?: string;
  /** Duration of hook execution in ms */
  duration: number;
  /** Error if hook failed */
  error?: string;
}

/**
 * Environment variables available to hook scripts
 */
export const HOOK_ENV_VARS = {
  /** Current session ID */
  SESSION_ID: 'HOOK_SESSION_ID',
  /** Event type */
  EVENT: 'HOOK_EVENT',
  /** Tool name (for tool events) */
  TOOL_NAME: 'HOOK_TOOL_NAME',
  /** Tool input as JSON (for tool events) */
  TOOL_INPUT: 'HOOK_TOOL_INPUT',
  /** Tool output (for PostToolUse) */
  TOOL_OUTPUT: 'HOOK_TOOL_OUTPUT',
  /** Error message (for failure events) */
  ERROR_MESSAGE: 'HOOK_ERROR_MESSAGE',
  /** Working directory */
  WORKING_DIR: 'HOOK_WORKING_DIR',
  /** User prompt (for UserPromptSubmit) */
  USER_PROMPT: 'HOOK_USER_PROMPT',
} as const;

/**
 * Create environment variables object from hook context
 */
export function createHookEnvVars(context: AnyHookContext): Record<string, string> {
  const env: Record<string, string> = {
    [HOOK_ENV_VARS.SESSION_ID]: context.sessionId,
    [HOOK_ENV_VARS.EVENT]: context.event,
    [HOOK_ENV_VARS.WORKING_DIR]: context.workingDirectory,
  };

  if ('toolName' in context) {
    env[HOOK_ENV_VARS.TOOL_NAME] = context.toolName;
    env[HOOK_ENV_VARS.TOOL_INPUT] = context.toolInput;
    if (context.toolOutput) {
      env[HOOK_ENV_VARS.TOOL_OUTPUT] = context.toolOutput;
    }
    if (context.errorMessage) {
      env[HOOK_ENV_VARS.ERROR_MESSAGE] = context.errorMessage;
    }
  }

  if ('prompt' in context) {
    env[HOOK_ENV_VARS.USER_PROMPT] = context.prompt;
  }

  return env;
}
