// ============================================================================
// Hook Configuration Parser
// Parse and validate hooks configuration from settings files
// ============================================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CONFIG_DIR_NEW, CONFIG_DIR_LEGACY } from '../config/configPaths';
import type { HookEvent } from '../protocol/events';
import { isProjectConfigTrusted } from '../security/folderTrustService';

// ----------------------------------------------------------------------------
// Configuration Types
// ----------------------------------------------------------------------------

/**
 * Hook type: command (external script), prompt (AI evaluation), or agent (AI agent role)
 */
export type HookType = 'command' | 'prompt' | 'agent' | 'http';

/**
 * Individual hook definition
 */
export interface HookDefinition {
  /** Hook type */
  type: HookType;
  /** For command hooks: the command/script to execute */
  command?: string;
  /** For prompt hooks: the prompt template */
  prompt?: string;
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Fire-and-forget execution (don't await result) */
  async?: boolean;
  /** Execute only once per session */
  once?: boolean;
  /** For agent hooks: agent role (e.g., 'reviewer') */
  agent?: string;
  /** For agent hooks: custom prompt for the agent */
  agentPrompt?: string;
  /** For HTTP hooks: target URL to POST to */
  url?: string;
  /** For HTTP hooks: HTTP headers (supports $ENV_VAR interpolation) */
  headers?: Record<string, string>;
  /** For HTTP hooks: env vars allowed in header interpolation */
  allowedEnvVars?: string[];
  /** Conditional execution: only run if tool input matches this pattern.
   *  Format: "ToolName(pattern)" e.g., "Bash(git *)", "Write(*.json)"
   *  Pattern is matched against stringified tool arguments. */
  if?: string;
}

/**
 * Hook matcher with array of hooks
 */
export interface HookMatcher {
  /** Regex pattern to match tool names (for tool events) */
  matcher?: string;
  /** Array of hooks to execute when matched */
  hooks: HookDefinition[];
  /** Phase 2: Execute hooks in parallel (default: false) */
  parallel?: boolean;
  /** Match MCP server tools by server name prefix (e.g., "github" matches "mcp__github__*") */
  mcpServer?: string;
  /**
   * Hook type: 'decision' hooks can block or modify; 'observer' hooks execute
   * but their block/modify results are ignored. Default: 'decision'.
   */
  hookType?: 'decision' | 'observer';
}

/**
 * Hooks configuration for all events
 */
export interface HooksConfig {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  PostToolUseFailure?: HookMatcher[];
  UserPromptSubmit?: HookMatcher[];
  Stop?: HookMatcher[];
  SubagentStop?: HookMatcher[];
  SubagentStart?: HookMatcher[];       // Phase 2
  PermissionRequest?: HookMatcher[];   // Phase 2
  PostExecution?: HookMatcher[];       // Harness: 每轮 turn 结束后
  PreCompact?: HookMatcher[];
  Setup?: HookMatcher[];
  SessionStart?: HookMatcher[];
  SessionEnd?: HookMatcher[];
  Notification?: HookMatcher[];
  TaskCreated?: HookMatcher[];
  TaskCompleted?: HookMatcher[];
  PermissionDenied?: HookMatcher[];   // Phase 3: observer-only
  PostCompact?: HookMatcher[];        // Phase 3: observer-only
  StopFailure?: HookMatcher[];        // Phase 3: observer-only
  RoleWake?: HookMatcher[];           // 角色主动性醒来: observer-only
}

/**
 * Settings file structure (partial, just hooks)
 */
interface SettingsFile {
  hooks?: HooksConfig;
}

/**
 * Parsed and validated hook configuration
 */
export interface ParsedHookConfig {
  event: HookEvent;
  matcher: RegExp | null;
  hooks: HookDefinition[];
  source: 'global' | 'project';
  /** Phase 2: Execute hooks in parallel */
  parallel: boolean;
  /** Match MCP server tools by server name prefix */
  mcpServer?: string;
  /** Hook type: 'decision' can block/modify, 'observer' is read-only. Default: 'decision'. */
  hookType: 'decision' | 'observer';
}

// ----------------------------------------------------------------------------
// Config Parser
// ----------------------------------------------------------------------------

/**
 * Parse hooks configuration from a file
 * Supports both formats:
 * - hooks.json: Direct HooksConfig object
 * - settings.json: { hooks: HooksConfig }
 */
export async function parseHooksConfig(
  filePath: string,
  source: 'global' | 'project',
  fileType: 'hooks-json' | 'settings-json' = 'settings-json'
): Promise<ParsedHookConfig[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);

    let hooksConfig: HooksConfig | undefined;

    if (fileType === 'hooks-json') {
      // New format: hooks.json is directly the HooksConfig
      hooksConfig = parsed as HooksConfig;
    } else {
      // Legacy format: settings.json contains { hooks: ... }
      const settings = parsed as SettingsFile;
      hooksConfig = settings.hooks;
    }

    if (!hooksConfig) {
      return [];
    }

    return parseHooksObject(hooksConfig, source);
  } catch {
    // File doesn't exist or is invalid - return empty config
    return [];
  }
}

/**
 * Events that are observer-only by nature: they report something that already
 * happened, so blocking or modifying makes no semantic sense.
 * If a user configures a 'decision' hook on these events, it is silently
 * downgraded to 'observer' with a console warning.
 */
const OBSERVER_ONLY_EVENTS: ReadonlySet<HookEvent> = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'PostExecution',
  'SessionStart',
  'SessionEnd',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'PermissionDenied',
  'PostCompact',
  'StopFailure',
  'RoleWake',
]);

function compileHookMatcher(
  matcher: string | undefined,
  event: HookEvent,
  source: 'global' | 'project',
): RegExp | null | undefined {
  const trimmed = matcher?.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return /.*/;

  try {
    return new RegExp(trimmed);
  } catch (error) {
    console.warn(
      `[Hooks] Warning: invalid matcher "${trimmed}" for event "${event}" ` +
        `in ${source} config. Skipping matcher. ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Parse hooks object into array of parsed configs
 */
function parseHooksObject(
  hooks: HooksConfig,
  source: 'global' | 'project'
): ParsedHookConfig[] {
  const result: ParsedHookConfig[] = [];
  const events: HookEvent[] = [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'UserPromptSubmit',
    'Stop',
    'SubagentStop',
    'SubagentStart',      // Phase 2
    'PermissionRequest',  // Phase 2
    'PreCompact',
    'Setup',
    'SessionStart',
    'SessionEnd',
    'PostExecution',
    'Notification',
    'TaskCreated',
    'TaskCompleted',
    'PermissionDenied',   // Phase 3
    'PostCompact',        // Phase 3
    'StopFailure',        // Phase 3
    'RoleWake',           // 角色主动性（内部文档 §2.3）
  ];

  // GAP-007: 未知事件名告警。
  // 大小写/拼写错误的事件名（如 "preToolUse"）会被静默忽略 = 用户以为有 hook 实际没有。
  const knownEventSet = new Set<string>(events);
  for (const key of Object.keys(hooks)) {
    if (!knownEventSet.has(key)) {
      const suggestion = events.find(e => e.toLowerCase() === key.toLowerCase());
      console.warn(
        `[Hooks] Warning: unknown event "${key}" in ${source} config is ignored.` +
          (suggestion ? ` Did you mean "${suggestion}"?` : '')
      );
    }
  }

  for (const event of events) {
    const matchers = hooks[event];
    if (!matchers || !Array.isArray(matchers)) {
      continue;
    }

    for (const matcherConfig of matchers) {
      const validatedHooks = validateHooks(matcherConfig.hooks);
      if (validatedHooks.length === 0) {
        continue;
      }

      const matcher = compileHookMatcher(matcherConfig.matcher, event, source);
      if (matcher === undefined) {
        continue;
      }

      // Resolve hookType: observer-only events force observer mode
      let hookType: 'decision' | 'observer' = matcherConfig.hookType ?? 'decision';
      if (hookType === 'decision' && OBSERVER_ONLY_EVENTS.has(event)) {
        if (matcherConfig.hookType === 'decision') {
          // Explicit decision on observer-only event → warn and downgrade
          console.warn(
            `[Hooks] Warning: event "${event}" is observer-only. ` +
              `Downgrading hookType from 'decision' to 'observer' (${source} config).`
          );
        }
        hookType = 'observer';
      }

      result.push({
        event,
        matcher,
        hooks: validatedHooks,
        source,
        parallel: matcherConfig.parallel ?? false,  // Phase 2: 并行执行支持
        mcpServer: matcherConfig.mcpServer,
        hookType,
      });
    }
  }

  return result;
}

/**
 * Validate and filter hooks array
 */
// GAP-007: HookDefinition 已知字段清单（与接口定义同步）
const KNOWN_HOOK_FIELDS = new Set([
  'type', 'command', 'prompt', 'timeout', 'async', 'once',
  'agent', 'agentPrompt', 'url', 'headers', 'allowedEnvVars', 'if',
]);

function validateHooks(hooks: unknown): HookDefinition[] {
  if (!Array.isArray(hooks)) {
    return [];
  }

  return hooks.filter((hook): hook is HookDefinition => {
    if (typeof hook !== 'object' || hook === null) {
      console.warn('[Hooks] Warning: hook entry dropped — not an object');
      return false;
    }

    const h = hook as Record<string, unknown>;

    // GAP-007: 被丢弃的 hook 必须告警（静默丢弃 = 用户以为有护栏实际没有）
    // Must have valid type
    if (h.type !== 'command' && h.type !== 'prompt' && h.type !== 'agent' && h.type !== 'http') {
      console.warn(
        `[Hooks] Warning: hook dropped — invalid type "${String(h.type)}" (expected command/prompt/agent/http)`
      );
      return false;
    }

    // Command hooks must have command
    if (h.type === 'command' && typeof h.command !== 'string') {
      console.warn('[Hooks] Warning: command hook dropped — missing "command" field');
      return false;
    }

    // Prompt hooks must have prompt
    if (h.type === 'prompt' && typeof h.prompt !== 'string') {
      console.warn('[Hooks] Warning: prompt hook dropped — missing "prompt" field');
      return false;
    }

    // Agent hooks must have agent role
    if (h.type === 'agent' && typeof h.agent !== 'string') {
      console.warn('[Hooks] Warning: agent hook dropped — missing "agent" field');
      return false;
    }

    // HTTP hooks must have url
    if (h.type === 'http' && typeof h.url !== 'string') {
      console.warn('[Hooks] Warning: http hook dropped — missing "url" field');
      return false;
    }

    // GAP-007: 未知字段告警（不 reject，保持向前兼容）
    for (const key of Object.keys(h)) {
      if (!KNOWN_HOOK_FIELDS.has(key)) {
        console.warn(
          `[Hooks] Warning: unknown field "${key}" in hook definition is ignored.`
        );
      }
    }

    return true;
  });
}

/**
 * Check if a hook matches the given tool name
 */
export function hookMatchesTool(
  config: ParsedHookConfig,
  toolName: string
): boolean {
  // No matcher means match all
  if (!config.matcher) {
    return true;
  }

  return config.matcher.test(toolName);
}

/**
 * Configuration path with priority and type info
 */
interface ConfigPath {
  path: string;
  type: 'hooks-json' | 'settings-json';
  priority: number; // Lower = higher priority
}

/**
 * Get hooks configuration file paths (supports both new and legacy formats)
 *
 * Priority order (highest first):
 * 1. .code-agent/hooks/hooks.json (native)
 * 2. .claude/settings.json (legacy settings shape)
 */
export function getHooksConfigPaths(workingDirectory: string): {
  global: ConfigPath[];
  project: ConfigPath[];
} {
  const homeDir = os.homedir();

  return {
    global: [
      // New format (higher priority)
      {
        path: path.join(homeDir, CONFIG_DIR_NEW, 'hooks', 'hooks.json'),
        type: 'hooks-json',
        priority: 0,
      },
      // Legacy format (lower priority)
      {
        path: path.join(homeDir, CONFIG_DIR_LEGACY, 'settings.json'),
        type: 'settings-json',
        priority: 1,
      },
    ],
    project: [
      // New format (higher priority)
      {
        path: path.join(workingDirectory, CONFIG_DIR_NEW, 'hooks', 'hooks.json'),
        type: 'hooks-json',
        priority: 0,
      },
      // Legacy format (lower priority)
      {
        path: path.join(workingDirectory, CONFIG_DIR_LEGACY, 'settings.json'),
        type: 'settings-json',
        priority: 1,
      },
    ],
  };
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load hooks from a source (global or project), respecting priority
 * Returns hooks from the highest priority file that exists
 */
async function loadHooksFromSource(
  configPaths: ConfigPath[],
  source: 'global' | 'project'
): Promise<{ hooks: ParsedHookConfig[]; usedPath?: string; hasLegacy?: boolean }> {
  // Sort by priority (lower = higher priority)
  const sortedPaths = [...configPaths].sort((a, b) => a.priority - b.priority);

  let usedPath: string | undefined;
  let hooks: ParsedHookConfig[] = [];
  let hasLegacy = false;

  // Check which files exist
  const existenceChecks = await Promise.all(
    sortedPaths.map(async (cp) => ({
      ...cp,
      exists: await fileExists(cp.path),
    }))
  );

  const existingPaths = existenceChecks.filter((cp) => cp.exists);

  // Warn if both new and legacy configs exist
  const hasNewFormat = existingPaths.some((cp) => cp.type === 'hooks-json');
  const hasLegacyFormat = existingPaths.some((cp) => cp.type === 'settings-json');

  if (hasNewFormat && hasLegacyFormat) {
    const newPath = existingPaths.find((cp) => cp.type === 'hooks-json')?.path;
    const legacyPath = existingPaths.find((cp) => cp.type === 'settings-json')?.path;
    console.warn(
      `[Hooks] Warning: Both new and legacy ${source} hook configs found.\n` +
        `  Using: ${newPath}\n` +
        `  Ignoring: ${legacyPath}\n` +
        `  Consider migrating to the new format and removing the legacy config.`
    );
    hasLegacy = true;
  }

  // Use the highest priority existing file
  if (existingPaths.length > 0) {
    const highestPriority = existingPaths[0];
    hooks = await parseHooksConfig(highestPriority.path, source, highestPriority.type);
    usedPath = highestPriority.path;
  }

  return { hooks, usedPath, hasLegacy };
}

/**
 * Load hooks from both global and project settings
 * Supports both new (.code-agent/hooks/hooks.json) and legacy (.claude/settings.json) formats
 */
export async function loadAllHooksConfig(
  workingDirectory: string
): Promise<ParsedHookConfig[]> {
  const paths = getHooksConfigPaths(workingDirectory);
  const projectTrusted = await isProjectConfigTrusted(workingDirectory, 'project-hooks');

  const emptyProjectResult: { hooks: ParsedHookConfig[]; usedPath?: string; hasLegacy?: boolean } = {
    hooks: [],
  };
  const [globalResult, projectResult] = await Promise.all([
    loadHooksFromSource(paths.global, 'global'),
    projectTrusted
      ? loadHooksFromSource(paths.project, 'project')
      : Promise.resolve(emptyProjectResult),
  ]);

  // Log which config files are being used (for debugging)
  if (globalResult.usedPath || projectResult.usedPath) {
    const sources: string[] = [];
    if (globalResult.usedPath) sources.push(`global: ${globalResult.usedPath}`);
    if (projectResult.usedPath) sources.push(`project: ${projectResult.usedPath}`);
    // Debug log - can be enabled via environment variable
    if (process.env.DEBUG_HOOKS) {
      console.log(`[Hooks] Loaded configs from: ${sources.join(', ')}`);
    }
  }

  // Project hooks come after global (will be merged with priority)
  return [...globalResult.hooks, ...projectResult.hooks];
}

// ============================================================================
// Hook 条件执行 (if 语法)
// ============================================================================

/**
 * Check if a hook's `if` condition matches the current tool call.
 * Format: "ToolName(pattern)" e.g., "Bash(git *)", "Write(*.json)"
 *
 * @param condition - The `if` field from HookDefinition
 * @param toolName - Current tool being called
 * @param toolInput - Stringified tool arguments
 * @returns true if condition matches (or no condition set)
 */
export function matchesCondition(
  condition: string | undefined,
  toolName: string,
  toolInput: string
): boolean {
  if (!condition) return true; // No condition = always match

  // Parse "ToolName(pattern)" syntax
  const match = condition.match(/^(\w+)\((.+)\)$/);
  if (!match) {
    // Simple tool name match (no pattern)
    return toolName === condition;
  }

  const [, condToolName, pattern] = match;

  // Tool name must match
  if (condToolName !== toolName) return false;

  // Convert glob-like pattern to regex: * → .*, ? → .
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars except * and ?
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  try {
    return new RegExp(`^${regexStr}$`).test(toolInput);
  } catch {
    return false;
  }
}

// ============================================================================
// Hook 配置快照
// ============================================================================

let hooksConfigSnapshot: ParsedHookConfig[] | null = null;

/**
 * Capture hooks configuration at startup.
 * Freezes the config so runtime changes don't affect hook execution.
 */
export async function captureHooksConfigSnapshot(workingDirectory: string): Promise<void> {
  hooksConfigSnapshot = await loadAllHooksConfig(workingDirectory);
}

/**
 * Get hooks config from snapshot (if captured) or load fresh.
 */
export function getHooksConfigFromSnapshot(): ParsedHookConfig[] | null {
  return hooksConfigSnapshot;
}

/**
 * Reset snapshot (for testing or config reload).
 */
export function resetHooksConfigSnapshot(): void {
  hooksConfigSnapshot = null;
}
