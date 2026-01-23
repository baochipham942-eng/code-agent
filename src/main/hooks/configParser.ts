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
}

// ----------------------------------------------------------------------------
// Config Parser
// ----------------------------------------------------------------------------

/**
 * Parse hooks configuration from a settings file
 */
export async function parseHooksConfig(
  filePath: string,
  source: 'global' | 'project'
): Promise<ParsedHookConfig[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const settings: SettingsFile = JSON.parse(content);

    if (!settings.hooks) {
      return [];
    }

    return parseHooksObject(settings.hooks, source);
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
 * Get hooks configuration file paths
 */
export function getHooksConfigPaths(workingDirectory: string): {
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
 * Load hooks from both global and project settings
 */
export async function loadAllHooksConfig(
  workingDirectory: string
): Promise<ParsedHookConfig[]> {
  const paths = getHooksConfigPaths(workingDirectory);

  const [globalHooks, projectHooks] = await Promise.all([
    parseHooksConfig(paths.global, 'global'),
    parseHooksConfig(paths.project, 'project'),
  ]);

  // Project hooks come after global (will be merged with priority)
  return [...globalHooks, ...projectHooks];
}
