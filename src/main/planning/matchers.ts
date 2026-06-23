// ============================================================================
// Matchers - Tool matching utilities for hooks
// ============================================================================

import type { HookContext } from './types';
import type { HookMatcher, ToolCategory, MatcherFactory } from './hooks/types';
import { TOOL_CATEGORIES } from './hooks/types';

// ----------------------------------------------------------------------------
// Core Matcher Functions
// ----------------------------------------------------------------------------

/**
 * Match a tool against a list of tool names
 */
export function matchTool(
  context: HookContext,
  ...toolNames: string[]
): boolean {
  if (!context.toolName) return false;
  return toolNames.includes(context.toolName);
}

/**
 * Match a tool against a category
 */
export function matchCategory(
  context: HookContext,
  category: ToolCategory
): boolean {
  if (!context.toolName) return false;
  const tools = TOOL_CATEGORIES[category];
  return tools?.includes(context.toolName) ?? false;
}

// ----------------------------------------------------------------------------
// Matcher Factory Implementation
// ----------------------------------------------------------------------------

/**
 * Factory for creating common matchers
 */
export const matchers: MatcherFactory = {
  /**
   * Match specific tool names
   * @example matchers.tools('bash', 'write_file')
   */
  tools: (...names: string[]): HookMatcher => {
    return (context: HookContext) => matchTool(context, ...names);
  },

  /**
   * Match tools in a category
   * @example matchers.category('critical')
   */
  category: (category: ToolCategory): HookMatcher => {
    return (context: HookContext) => matchCategory(context, category);
  },

  /**
   * Always match (triggers for any context)
   */
  any: (): HookMatcher => {
    return () => true;
  },

  /**
   * Combine matchers with AND logic (all must match)
   * @example matchers.and(matchers.category('critical'), matchers.tools('bash'))
   */
  and: (...matcherList: HookMatcher[]): HookMatcher => {
    return (context: HookContext) => {
      return matcherList.every((m) => m(context));
    };
  },

  /**
   * Combine matchers with OR logic (any can match)
   * @example matchers.or(matchers.tools('bash'), matchers.tools('write_file'))
   */
  or: (...matcherList: HookMatcher[]): HookMatcher => {
    return (context: HookContext) => {
      return matcherList.some((m) => m(context));
    };
  },

  /**
   * Negate a matcher
   * @example matchers.not(matchers.category('view'))
   */
  not: (matcher: HookMatcher): HookMatcher => {
    return (context: HookContext) => !matcher(context);
  },
};

// ----------------------------------------------------------------------------
// Additional Matcher Utilities
// ----------------------------------------------------------------------------

/**
 * Create a matcher for dangerous bash commands
 */
export function matchDangerousBash(): HookMatcher {
  const dangerousPatterns = [
    /rm\s+-rf?\s+[/~]/i, // rm -rf / or ~
    /rm\s+-rf?\s+\*/i, // rm -rf *
    />\s*\/dev\/sd[a-z]/i, // Writing to disk devices
    /mkfs/i, // Format filesystem
    /dd\s+if=.*of=\/dev/i, // dd to device
    /chmod\s+-R?\s+777/i, // chmod 777
    /:\s*\(\)\s*{\s*:\s*\|\s*:\s*&\s*}\s*;/i, // Fork bomb
  ];

  return (context: HookContext) => {
    // The bash tool registers as 'Bash' at runtime (see bash.schema.ts);
    // normalize so the safety blocker fires regardless of casing.
    if (context.toolName?.toLowerCase() !== 'bash') return false;
    const command = context.toolParams?.command as string | undefined;
    if (!command) return false;
    return dangerousPatterns.some((pattern) => pattern.test(command));
  };
}

