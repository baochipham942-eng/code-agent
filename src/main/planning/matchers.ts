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

/**
 * Check if a tool result indicates failure
 */
export function matchFailed(context: HookContext): boolean {
  return context.toolResult?.success === false;
}

/**
 * Check if a tool result indicates success
 */
export function matchSuccess(context: HookContext): boolean {
  return context.toolResult?.success === true;
}

/**
 * Check if there's an error in context
 */
export function matchError(context: HookContext): boolean {
  return context.error !== undefined;
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
 * Create a matcher that checks tool params against a predicate
 */
export function matchParams(
  predicate: (params: Record<string, unknown>) => boolean
): HookMatcher {
  return (context: HookContext) => {
    if (!context.toolParams) return false;
    return predicate(context.toolParams);
  };
}

/**
 * Create a matcher that checks if action count exceeds threshold
 */
export function matchActionCount(threshold: number): HookMatcher {
  return (context: HookContext) => {
    return (context.actionCount ?? 0) >= threshold;
  };
}

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
    if (context.toolName !== 'bash') return false;
    const command = context.toolParams?.command as string | undefined;
    if (!command) return false;
    return dangerousPatterns.some((pattern) => pattern.test(command));
  };
}

/**
 * Create a matcher for file paths matching a pattern
 */
export function matchFilePath(pattern: RegExp): HookMatcher {
  return (context: HookContext) => {
    const filePath =
      (context.toolParams?.file_path as string) ||
      (context.toolParams?.path as string);
    if (!filePath) return false;
    return pattern.test(filePath);
  };
}
