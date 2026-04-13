// ============================================================================
// Hook Types — 主进程 Hook 系统的类型层
// 原 src/main/hooks/events.ts，P0-5 阶段 +1 下沉到 protocol 层
// 作为 HOOK_EVENTS 字典的权威定义，替换原 categories.ts 中冗余的 HOOK_EVENTS 常量
// ============================================================================

/**
 * All supported hook event types
 *
 * 19 event types covering the full lifecycle of agent interactions.
 * Each event is annotated with a stability level:
 *
 * - **stable**: API is frozen; safe for external consumers.
 * - **experimental**: API may change between minor versions.
 * - **planned**: Defined but not yet wired to real triggers.
 * - **internal @deprecated**: Will be removed in a future version.
 */
// Stability legend (non-JSDoc to avoid @deprecated propagation to HookEvent union):
//   stable       — API frozen, safe for external consumers
//   experimental — may change between minor versions
//   internal     — will be removed; do not use externally
export type HookEvent =
  // stable
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PostExecution'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStop'
  // experimental
  | 'SubagentStart'
  | 'PermissionRequest'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'PermissionDenied'
  | 'PostCompact'
  | 'StopFailure'
  // internal (legacy)
  | 'Setup'
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
  SubagentStart: 'Triggered when a subagent is about to start.',
  PermissionRequest: 'Triggered when a permission is requested.',
  PostExecution: 'Triggered after each agent turn completes. Used for async health checks and GC scans.',
  PreCompact: 'Triggered before context compaction/summarization.',
  Setup: 'Triggered once during initial setup of the session.',
  SessionStart: 'Triggered when a new session begins.',
  SessionEnd: 'Triggered when a session ends.',
  Notification: 'Triggered when a notification needs to be sent.',
  TaskCreated: 'Triggered when an agent task is created.',
  TaskCompleted: 'Triggered when an agent task completes.',
  PermissionDenied: 'Triggered when a tool permission is denied (observer-only).',
  PostCompact: 'Triggered after context compaction completes (observer-only).',
  StopFailure: 'Triggered when the agent stops due to an error (observer-only).',
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
 * Context for subagent start events (Phase 2)
 */
export interface SubagentStartContext extends HookEventContext {
  event: 'SubagentStart';
  /** The subagent type/role */
  subagentType: string;
  /** Unique subagent ID */
  subagentId: string;
  /** The task prompt */
  taskPrompt: string;
  /** Parent tool use ID (if any) */
  parentToolUseId?: string;
}

/**
 * Context for permission request events (Phase 2)
 */
export interface PermissionRequestContext extends HookEventContext {
  event: 'PermissionRequest';
  /** Type of permission being requested */
  permissionType: 'read' | 'write' | 'execute' | 'network' | 'dangerous';
  /** The resource being accessed */
  resource: string;
  /** Reason for the request */
  reason?: string;
  /** Tool requesting the permission */
  toolName: string;
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
 * Context for post-execution events (after each agent turn)
 */
export interface PostExecutionContext extends HookEventContext {
  event: 'PostExecution';
  /** Number of turns completed in this session */
  turnCount: number;
  /** Tools used in this turn */
  toolsUsed: string[];
  /** Files modified in this turn */
  modifiedFiles: string[];
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
 * Context for task creation events
 * @planned
 */
export interface TaskCreatedContext extends HookEventContext {
  event: 'TaskCreated';
  taskId: string;
  agentType: string;
}

/**
 * Context for task completion events
 * @planned
 */
export interface TaskCompletedContext extends HookEventContext {
  event: 'TaskCompleted';
  taskId: string;
  agentType: string;
  success: boolean;
}

/**
 * Context for permission denied events (observer-only)
 * @experimental
 */
export interface PermissionDeniedContext extends HookEventContext {
  event: 'PermissionDenied';
  toolName: string;
  reason: string;
  deniedBy: 'user' | 'hook' | 'policy' | 'classifier';
}

/**
 * Context for post-compaction events (observer-only)
 * @experimental
 */
export interface PostCompactContext extends HookEventContext {
  event: 'PostCompact';
  savedTokens: number;
  strategy: string;
}

/**
 * Context for stop failure events (observer-only)
 * @experimental
 */
export interface StopFailureContext extends HookEventContext {
  event: 'StopFailure';
  error: string;
  phase: string;
}

/**
 * Union type of all hook contexts
 */
export type AnyHookContext =
  | HookEventContext
  | ToolHookContext
  | UserPromptContext
  | StopContext
  | SubagentStartContext
  | PermissionRequestContext
  | PostExecutionContext
  | SessionContext
  | CompactContext
  | NotificationContext
  | TaskCreatedContext
  | TaskCompletedContext
  | PermissionDeniedContext
  | PostCompactContext
  | StopFailureContext;

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
 * Type guard for ToolHookContext
 */
function isToolHookContext(context: AnyHookContext): context is ToolHookContext {
  return context.event === 'PreToolUse' ||
    context.event === 'PostToolUse' ||
    context.event === 'PostToolUseFailure';
}

/**
 * Type guard for PermissionRequestContext
 */
function isPermissionRequestContext(context: AnyHookContext): context is PermissionRequestContext {
  return context.event === 'PermissionRequest';
}

/**
 * Create environment variables object from hook context
 */
export function createHookEnvVars(context: AnyHookContext): Record<string, string> {
  const env: Record<string, string> = {
    [HOOK_ENV_VARS.SESSION_ID]: context.sessionId,
    [HOOK_ENV_VARS.EVENT]: context.event,
    [HOOK_ENV_VARS.WORKING_DIR]: context.workingDirectory,
  };

  // Tool hook contexts (PreToolUse, PostToolUse, PostToolUseFailure)
  if (isToolHookContext(context)) {
    env[HOOK_ENV_VARS.TOOL_NAME] = context.toolName;
    env[HOOK_ENV_VARS.TOOL_INPUT] = context.toolInput;
    if (context.toolOutput) {
      env[HOOK_ENV_VARS.TOOL_OUTPUT] = context.toolOutput;
    }
    if (context.errorMessage) {
      env[HOOK_ENV_VARS.ERROR_MESSAGE] = context.errorMessage;
    }
  }

  // Permission request context
  if (isPermissionRequestContext(context)) {
    env[HOOK_ENV_VARS.TOOL_NAME] = context.toolName;
    env['HOOK_PERMISSION_TYPE'] = context.permissionType;
    env['HOOK_RESOURCE'] = context.resource;
    if (context.reason) {
      env['HOOK_REASON'] = context.reason;
    }
  }

  if ('prompt' in context) {
    env[HOOK_ENV_VARS.USER_PROMPT] = context.prompt;
  }

  // Task lifecycle contexts
  if (context.event === 'TaskCreated' || context.event === 'TaskCompleted') {
    if ('taskId' in context) env['HOOK_TASK_ID'] = String(context.taskId);
    if ('agentType' in context) env['HOOK_AGENT_TYPE'] = String(context.agentType);
    if ('success' in context) env['HOOK_TASK_SUCCESS'] = String(context.success);
  }

  // Permission denied context
  if (context.event === 'PermissionDenied' && 'deniedBy' in context) {
    env[HOOK_ENV_VARS.TOOL_NAME] = String((context as PermissionDeniedContext).toolName);
    env['HOOK_DENIED_BY'] = String((context as PermissionDeniedContext).deniedBy);
    env['HOOK_REASON'] = String((context as PermissionDeniedContext).reason);
  }

  // Post compact context
  if (context.event === 'PostCompact' && 'savedTokens' in context) {
    env['HOOK_SAVED_TOKENS'] = String((context as PostCompactContext).savedTokens);
    env['HOOK_STRATEGY'] = String((context as PostCompactContext).strategy);
  }

  // Stop failure context
  if (context.event === 'StopFailure' && 'phase' in context) {
    env[HOOK_ENV_VARS.ERROR_MESSAGE] = String((context as StopFailureContext).error);
    env['HOOK_PHASE'] = String((context as StopFailureContext).phase);
  }

  return env;
}
