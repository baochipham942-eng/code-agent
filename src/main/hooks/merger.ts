// ============================================================================
// Hook Merger - Merge hooks from multiple sources
// ============================================================================

import type { HookEvent } from './events';
import type { ParsedHookConfig, HookDefinition } from './configParser';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Merged hook configuration
 */
export interface MergedHookConfig {
  event: HookEvent;
  matcher: RegExp | null;
  hooks: HookDefinition[];
  /** Sources that contributed to this config */
  sources: Array<'global' | 'project'>;
}

/**
 * Merge strategy for hooks
 */
export type MergeStrategy = 'append' | 'replace' | 'prepend';

// ----------------------------------------------------------------------------
// Merger
// ----------------------------------------------------------------------------

/**
 * Merge hooks from multiple sources with configurable strategy
 *
 * Default strategy: 'append'
 * - Global hooks run first
 * - Project hooks run after (can override)
 *
 * 'replace' strategy:
 * - Project hooks completely replace global hooks for the same event/matcher
 *
 * 'prepend' strategy:
 * - Project hooks run before global hooks
 */
export function mergeHooks(
  configs: ParsedHookConfig[],
  strategy: MergeStrategy = 'append'
): MergedHookConfig[] {
  // Group by event and matcher pattern
  const grouped = new Map<string, ParsedHookConfig[]>();

  for (const config of configs) {
    const key = `${config.event}:${config.matcher?.source || '*'}`;
    const existing = grouped.get(key) || [];
    existing.push(config);
    grouped.set(key, existing);
  }

  // Merge each group
  const result: MergedHookConfig[] = [];

  for (const [, group] of grouped) {
    const merged = mergeGroup(group, strategy);
    if (merged.hooks.length > 0) {
      result.push(merged);
    }
  }

  return result;
}

/**
 * Merge a group of configs with the same event/matcher
 */
function mergeGroup(
  configs: ParsedHookConfig[],
  strategy: MergeStrategy
): MergedHookConfig {
  // Sort by source: global first, then project
  const sorted = [...configs].sort((a, b) => {
    if (a.source === 'global' && b.source === 'project') return -1;
    if (a.source === 'project' && b.source === 'global') return 1;
    return 0;
  });

  const first = sorted[0];
  const sources = new Set<'global' | 'project'>();
  let hooks: HookDefinition[] = [];

  for (const config of sorted) {
    sources.add(config.source);

    switch (strategy) {
      case 'replace':
        // Later sources replace earlier ones
        hooks = [...config.hooks];
        break;

      case 'prepend':
        // Later sources come before earlier ones
        hooks = [...config.hooks, ...hooks];
        break;

      case 'append':
      default:
        // Later sources come after earlier ones
        hooks = [...hooks, ...config.hooks];
        break;
    }
  }

  // Deduplicate hooks (by command/prompt string)
  hooks = deduplicateHooks(hooks);

  return {
    event: first.event,
    matcher: first.matcher,
    hooks,
    sources: Array.from(sources),
  };
}

/**
 * Deduplicate hooks based on their command/prompt
 */
function deduplicateHooks(hooks: HookDefinition[]): HookDefinition[] {
  const seen = new Set<string>();
  const result: HookDefinition[] = [];

  for (const hook of hooks) {
    const key = hook.type === 'command'
      ? `command:${hook.command}`
      : `prompt:${hook.prompt}`;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(hook);
    }
  }

  return result;
}

/**
 * Filter merged hooks by event type
 */
export function getHooksForEvent(
  hooks: MergedHookConfig[],
  event: HookEvent
): MergedHookConfig[] {
  return hooks.filter((h) => h.event === event);
}

/**
 * Filter hooks that match a specific tool name
 */
export function getHooksForTool(
  hooks: MergedHookConfig[],
  event: HookEvent,
  toolName: string
): MergedHookConfig[] {
  return hooks.filter((h) => {
    if (h.event !== event) return false;

    // No matcher means match all tools
    if (!h.matcher) return true;

    return h.matcher.test(toolName);
  });
}

/**
 * Check if any hooks are configured for an event
 */
export function hasHooksForEvent(
  hooks: MergedHookConfig[],
  event: HookEvent
): boolean {
  return hooks.some((h) => h.event === event);
}
