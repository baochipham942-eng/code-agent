// ============================================================================
// Hook Merger - Merge hooks from multiple sources
// ============================================================================

import type { HookEvent } from '../protocol/events';
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
  /** Phase 2: Execute hooks in parallel */
  parallel: boolean;
  /** Match MCP server tools by server name prefix */
  mcpServer?: string;
  /** Hook type: 'decision' can block/modify, 'observer' is read-only. Default: 'decision'. */
  hookType: 'decision' | 'observer';
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

  // Phase 2: 如果任何配置标记为并行，则整个组并行执行
  const parallel = sorted.some(config => config.parallel);

  // Observer wins: if any source marks this group as observer, the merged
  // result is observer (safer default when sources disagree).
  const hookType = sorted.some(config => config.hookType === 'observer')
    ? 'observer' as const
    : 'decision' as const;

  return {
    event: first.event,
    matcher: first.matcher,
    hooks,
    sources: Array.from(sources),
    parallel,
    mcpServer: first.mcpServer,
    hookType,
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
 * 丢掉被停用的 hook 定义；整组都停用了就不返回这一组。
 * 过滤放在这里而不是执行处：hasHooksForEvent 这类「有没有 hook 要跑」的判断
 * 也走同一条出口，否则会出现「说有 hook 但一个都不跑」。
 */
function withoutDisabled(configs: MergedHookConfig[]): MergedHookConfig[] {
  const result: MergedHookConfig[] = [];
  for (const config of configs) {
    const hooks = config.hooks.filter((hook) => !hook.disabled);
    if (hooks.length === config.hooks.length) {
      result.push(config);
      continue;
    }
    // 只丢「本来有 hook、全被停用了」的组；本来就空的组保持原样（那是别处的语义，不归这里管）
    if (hooks.length > 0) result.push({ ...config, hooks });
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
  return withoutDisabled(hooks.filter((h) => h.event === event));
}

/**
 * Filter hooks that match a specific tool name
 */
export function getHooksForTool(
  hooks: MergedHookConfig[],
  event: HookEvent,
  toolName: string
): MergedHookConfig[] {
  return withoutDisabled(hooks).filter((h) => {
    if (h.event !== event) return false;

    // When mcpServer is set, match against the MCP server name prefix
    // e.g., mcpServer: "github" matches tool names like "mcp__github__create_issue"
    if (h.mcpServer) {
      const mcpPrefix = `mcp__${h.mcpServer}__`;
      return toolName.startsWith(mcpPrefix);
    }

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
  return getHooksForEvent(hooks, event).length > 0;
}
