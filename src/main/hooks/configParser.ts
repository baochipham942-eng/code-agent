// ============================================================================
// Hook Configuration Parser
// Parse and validate hooks configuration from settings files
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { HookEvent } from './events';

// ----------------------------------------------------------------------------
// Configuration Types
// ----------------------------------------------------------------------------

/**
 * Hook type: command (external script) or prompt (AI evaluation)
 */
export type HookType = 'command' | 'prompt';

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
  PreCompact?: HookMatcher[];
  Setup?: HookMatcher[];
  SessionStart?: HookMatcher[];
  SessionEnd?: HookMatcher[];
  Notification?: HookMatcher[];
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
    const parsed = JSON.parse(content);

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
  } catch (error) {
    // File doesn't exist or is invalid - return empty config
    return [];
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
    'Notification',
  ];

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

      result.push({
        event,
        matcher: matcherConfig.matcher ? new RegExp(matcherConfig.matcher) : null,
        hooks: validatedHooks,
        source,
        parallel: matcherConfig.parallel ?? false,  // Phase 2: 并行执行支持
      });
    }
  }

  return result;
}

/**
 * Validate and filter hooks array
 */
function validateHooks(hooks: unknown): HookDefinition[] {
  if (!Array.isArray(hooks)) {
    return [];
  }

  return hooks.filter((hook): hook is HookDefinition => {
    if (typeof hook !== 'object' || hook === null) {
      return false;
    }

    const h = hook as Record<string, unknown>;

    // Must have valid type
    if (h.type !== 'command' && h.type !== 'prompt') {
      return false;
    }

    // Command hooks must have command
    if (h.type === 'command' && typeof h.command !== 'string') {
      return false;
    }

    // Prompt hooks must have prompt
    if (h.type === 'prompt' && typeof h.prompt !== 'string') {
      return false;
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
 * 1. Project: .code-agent/hooks/hooks.json (new format)
 * 2. Project: .claude/settings.json (legacy)
 * 3. Global: ~/.code-agent/hooks/hooks.json (new format)
 * 4. Global: ~/.claude/settings.json (legacy)
 */
export function getHooksConfigPaths(workingDirectory: string): {
  global: ConfigPath[];
  project: ConfigPath[];
} {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  return {
    global: [
      // New format (higher priority)
      {
        path: path.join(homeDir, '.code-agent', 'hooks', 'hooks.json'),
        type: 'hooks-json',
        priority: 0,
      },
      // Legacy format (lower priority)
      {
        path: path.join(homeDir, '.claude', 'settings.json'),
        type: 'settings-json',
        priority: 1,
      },
    ],
    project: [
      // New format (higher priority)
      {
        path: path.join(workingDirectory, '.code-agent', 'hooks', 'hooks.json'),
        type: 'hooks-json',
        priority: 0,
      },
      // Legacy format (lower priority)
      {
        path: path.join(workingDirectory, '.claude', 'settings.json'),
        type: 'settings-json',
        priority: 1,
      },
    ],
  };
}

/**
 * @deprecated Use getHooksConfigPaths instead
 * Legacy function for backward compatibility
 */
export function getLegacyHooksConfigPaths(workingDirectory: string): {
  global: string;
  project: string;
} {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  return {
    global: path.join(homeDir, '.claude', 'settings.json'),
    project: path.join(workingDirectory, '.claude', 'settings.json'),
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

  const [globalResult, projectResult] = await Promise.all([
    loadHooksFromSource(paths.global, 'global'),
    loadHooksFromSource(paths.project, 'project'),
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
