// ============================================================================
// Hook Merger Tests
// ============================================================================
//
// Tests for the hook merging module.
// Tests cover:
// - Merging hooks from multiple sources
// - Different merge strategies (append, replace, prepend)
// - Deduplication of hooks
// - Filtering by event and tool
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  mergeHooks,
  getHooksForEvent,
  getHooksForTool,
  hasHooksForEvent,
  type MergedHookConfig,
} from '../../../src/main/hooks/merger';
import type { ParsedHookConfig, HookDefinition } from '../../../src/main/hooks/configParser';

describe('Hook Merger', () => {
  // --------------------------------------------------------------------------
  // mergeHooks
  // --------------------------------------------------------------------------
  describe('mergeHooks', () => {
    it('should merge hooks from single source', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'hook.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs);

      expect(result).toHaveLength(1);
      expect(result[0].event).toBe('PreToolUse');
      expect(result[0].hooks).toHaveLength(1);
      expect(result[0].sources).toContain('project');
    });

    it('should merge hooks with append strategy (default)', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'global.sh' }],
          source: 'global',
        },
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'project.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs, 'append');

      expect(result).toHaveLength(1);
      expect(result[0].hooks).toHaveLength(2);
      expect(result[0].hooks[0].command).toBe('global.sh');
      expect(result[0].hooks[1].command).toBe('project.sh');
      expect(result[0].sources).toContain('global');
      expect(result[0].sources).toContain('project');
    });

    it('should merge hooks with replace strategy', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'global.sh' }],
          source: 'global',
        },
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'project.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs, 'replace');

      expect(result).toHaveLength(1);
      expect(result[0].hooks).toHaveLength(1);
      expect(result[0].hooks[0].command).toBe('project.sh');
    });

    it('should merge hooks with prepend strategy', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'global.sh' }],
          source: 'global',
        },
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'project.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs, 'prepend');

      expect(result).toHaveLength(1);
      expect(result[0].hooks).toHaveLength(2);
      expect(result[0].hooks[0].command).toBe('project.sh');
      expect(result[0].hooks[1].command).toBe('global.sh');
    });

    it('should keep different matchers separate', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'bash-hook.sh' }],
          source: 'project',
        },
        {
          event: 'PreToolUse',
          matcher: /edit_file/,
          hooks: [{ type: 'command', command: 'edit-hook.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs);

      expect(result).toHaveLength(2);
    });

    it('should keep different events separate', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'pre.sh' }],
          source: 'project',
        },
        {
          event: 'PostToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'post.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs);

      expect(result).toHaveLength(2);
      expect(result.find(r => r.event === 'PreToolUse')).toBeDefined();
      expect(result.find(r => r.event === 'PostToolUse')).toBeDefined();
    });

    it('should deduplicate identical hooks', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'same.sh' }],
          source: 'global',
        },
        {
          event: 'PreToolUse',
          matcher: /bash/,
          hooks: [{ type: 'command', command: 'same.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs, 'append');

      expect(result).toHaveLength(1);
      expect(result[0].hooks).toHaveLength(1);
    });

    it('should handle empty configs array', () => {
      const result = mergeHooks([]);
      expect(result).toEqual([]);
    });

    it('should handle null matchers', () => {
      const configs: ParsedHookConfig[] = [
        {
          event: 'PreToolUse',
          matcher: null,
          hooks: [{ type: 'command', command: 'all.sh' }],
          source: 'global',
        },
        {
          event: 'PreToolUse',
          matcher: null,
          hooks: [{ type: 'command', command: 'project-all.sh' }],
          source: 'project',
        },
      ];

      const result = mergeHooks(configs);

      expect(result).toHaveLength(1);
      expect(result[0].matcher).toBeNull();
      expect(result[0].hooks).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // getHooksForEvent
  // --------------------------------------------------------------------------
  describe('getHooksForEvent', () => {
    const hooks: MergedHookConfig[] = [
      { event: 'PreToolUse', matcher: /bash/, hooks: [], sources: ['project'] },
      { event: 'PreToolUse', matcher: /edit/, hooks: [], sources: ['project'] },
      { event: 'PostToolUse', matcher: /bash/, hooks: [], sources: ['project'] },
      { event: 'SessionStart', matcher: null, hooks: [], sources: ['global'] },
    ];

    it('should filter by event type', () => {
      const result = getHooksForEvent(hooks, 'PreToolUse');
      expect(result).toHaveLength(2);
    });

    it('should return empty for non-existent event', () => {
      const result = getHooksForEvent(hooks, 'Stop');
      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getHooksForTool
  // --------------------------------------------------------------------------
  describe('getHooksForTool', () => {
    const hooks: MergedHookConfig[] = [
      { event: 'PreToolUse', matcher: /bash/, hooks: [{ type: 'command', command: 'bash.sh' }], sources: ['project'] },
      { event: 'PreToolUse', matcher: /edit_file/, hooks: [{ type: 'command', command: 'edit.sh' }], sources: ['project'] },
      { event: 'PreToolUse', matcher: null, hooks: [{ type: 'command', command: 'all.sh' }], sources: ['global'] },
      { event: 'PostToolUse', matcher: /bash/, hooks: [{ type: 'command', command: 'post-bash.sh' }], sources: ['project'] },
    ];

    it('should filter by event and matching tool', () => {
      const result = getHooksForTool(hooks, 'PreToolUse', 'bash');
      expect(result).toHaveLength(2); // bash matcher + null matcher
    });

    it('should return null matcher hooks for any tool', () => {
      const result = getHooksForTool(hooks, 'PreToolUse', 'read_file');
      expect(result).toHaveLength(1);
      expect(result[0].matcher).toBeNull();
    });

    it('should not return hooks for non-matching tools', () => {
      const result = getHooksForTool(hooks, 'PostToolUse', 'edit_file');
      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // hasHooksForEvent
  // --------------------------------------------------------------------------
  describe('hasHooksForEvent', () => {
    const hooks: MergedHookConfig[] = [
      { event: 'PreToolUse', matcher: null, hooks: [], sources: ['project'] },
      { event: 'SessionStart', matcher: null, hooks: [], sources: ['global'] },
    ];

    it('should return true for configured events', () => {
      expect(hasHooksForEvent(hooks, 'PreToolUse')).toBe(true);
      expect(hasHooksForEvent(hooks, 'SessionStart')).toBe(true);
    });

    it('should return false for non-configured events', () => {
      expect(hasHooksForEvent(hooks, 'PostToolUse')).toBe(false);
      expect(hasHooksForEvent(hooks, 'Stop')).toBe(false);
    });

    it('should return false for empty hooks array', () => {
      expect(hasHooksForEvent([], 'PreToolUse')).toBe(false);
    });
  });
});
