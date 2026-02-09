// ============================================================================
// Hooks Module - User-configurable hooks system
// Based on Claude Code v2.0 hook architecture
// ============================================================================

// Event types and context
export {
  type HookEvent,
  type HookActionResult,
  type HookEventContext,
  type ToolHookContext,
  type UserPromptContext,
  type StopContext,
  type SessionContext,
  type CompactContext,
  type NotificationContext,
  type AnyHookContext,
  type HookExecutionResult,
  HOOK_EVENT_DESCRIPTIONS,
  HOOK_ENV_VARS,
  createHookEnvVars,
} from './events';

// Configuration parsing
export {
  type HookType,
  type HookDefinition,
  type HookMatcher,
  type HooksConfig,
  type ParsedHookConfig,
  parseHooksConfig,
  loadAllHooksConfig,
  hookMatchesTool,
  getHooksConfigPaths,
} from './configParser';

// Hook merging
export {
  type MergedHookConfig,
  type MergeStrategy,
  mergeHooks,
  getHooksForEvent,
  getHooksForTool,
  hasHooksForEvent,
} from './merger';

// Script execution
export {
  type ScriptExecutorOptions,
  executeScript,
  createScriptExecutor,
} from './scriptExecutor';

// Prompt-based hooks
export {
  type PromptHookOptions,
  type AICompletionFn,
  executePromptHook,
} from './promptHook';

// Hook Manager (main API)
export {
  type HookManagerConfig,
  type HookTriggerResult,
  HookManager,
  createHookManager,
} from './hookManager';
