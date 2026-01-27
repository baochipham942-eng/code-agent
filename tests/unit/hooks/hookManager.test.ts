// ============================================================================
// HookManager Tests
// TDD tests for the unified hooks system
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookManager, createHookManager } from '../../../src/main/hooks/hookManager';
import type { HookManagerConfig } from '../../../src/main/hooks/hookManager';

// Mock the config parser and merger
vi.mock('../../../src/main/hooks/configParser', () => ({
  loadAllHooksConfig: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/main/hooks/merger', () => ({
  mergeHooks: vi.fn().mockReturnValue([]),
  getHooksForTool: vi.fn().mockReturnValue([]),
  getHooksForEvent: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/main/hooks/builtinHookExecutor', () => ({
  getBuiltinHookExecutor: vi.fn().mockReturnValue({
    executeForEvent: vi.fn().mockResolvedValue([]),
  }),
}));

// ----------------------------------------------------------------------------
// HookManager Creation Tests
// ----------------------------------------------------------------------------

describe('HookManager', () => {
  let manager: HookManager;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with required config', () => {
      const config: HookManagerConfig = {
        workingDirectory: '/tmp',
      };
      manager = new HookManager(config);
      expect(manager).toBeDefined();
    });

    it('should default enabled to true', () => {
      manager = new HookManager({ workingDirectory: '/tmp' });
      // enabled is private, but we can test its effect
      expect(manager).toBeDefined();
    });

    it('should accept custom merge strategy', () => {
      manager = new HookManager({
        workingDirectory: '/tmp',
        mergeStrategy: 'override',
      });
      expect(manager).toBeDefined();
    });

    it('should accept AI completion function', () => {
      const aiCompletion = vi.fn();
      manager = new HookManager({
        workingDirectory: '/tmp',
        aiCompletion,
      });
      expect(manager).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      manager = new HookManager({ workingDirectory: '/tmp' });
      await expect(manager.initialize()).resolves.not.toThrow();
    });

    it('should only initialize once', async () => {
      const { loadAllHooksConfig } = await import('../../../src/main/hooks/configParser');
      manager = new HookManager({ workingDirectory: '/tmp' });

      await manager.initialize();
      await manager.initialize();

      expect(loadAllHooksConfig).toHaveBeenCalledTimes(1);
    });

    it('should handle initialization errors gracefully', async () => {
      const { loadAllHooksConfig } = await import('../../../src/main/hooks/configParser');
      vi.mocked(loadAllHooksConfig).mockRejectedValueOnce(new Error('Config error'));

      manager = new HookManager({ workingDirectory: '/tmp' });
      await expect(manager.initialize()).resolves.not.toThrow();
    });
  });

  describe('reload', () => {
    it('should reinitialize hooks', async () => {
      const { loadAllHooksConfig } = await import('../../../src/main/hooks/configParser');
      manager = new HookManager({ workingDirectory: '/tmp' });

      await manager.initialize();
      await manager.reload();

      expect(loadAllHooksConfig).toHaveBeenCalledTimes(2);
    });
  });
});

// ----------------------------------------------------------------------------
// Hook Trigger Tests
// ----------------------------------------------------------------------------

describe('HookManager Trigger Methods', () => {
  let manager: HookManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();
  });

  describe('triggerPreToolUse', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerPreToolUse('bash', 'echo test', 'session-1');
      expect(result.shouldProceed).toBe(true);
      expect(result.results).toEqual([]);
    });

    it('should include totalDuration', async () => {
      const result = await manager.triggerPreToolUse('bash', 'echo test', 'session-1');
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('triggerPostToolUse', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerPostToolUse('bash', 'echo test', 'output', 'session-1');
      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('triggerPostToolUseFailure', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerPostToolUseFailure(
        'bash',
        'invalid command',
        'Command not found',
        'session-1'
      );
      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('triggerUserPromptSubmit', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerUserPromptSubmit('Hello world', 'session-1');
      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('triggerStop', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerStop('Task completed', 'session-1');
      expect(result.shouldProceed).toBe(true);
    });

    it('should handle undefined response', async () => {
      const result = await manager.triggerStop(undefined, 'session-1');
      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('triggerSessionStart', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerSessionStart('session-1');
      expect(result.shouldProceed).toBe(true);
    });

    it('should return injectedContext if available', async () => {
      const result = await manager.triggerSessionStart('session-1');
      // No injected context when no builtin hooks return it
      expect(result.injectedContext).toBeUndefined();
    });
  });

  describe('triggerSessionEnd', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerSessionEnd('session-1');
      expect(result.shouldProceed).toBe(true);
    });

    it('should accept messages and tool executions', async () => {
      const result = await manager.triggerSessionEnd(
        'session-1',
        [{ role: 'user', content: 'test' }],
        [{ name: 'bash', input: 'echo', success: true, timestamp: Date.now() }]
      );
      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('triggerPreCompact', () => {
    it('should return shouldProceed=true when no hooks configured', async () => {
      const result = await manager.triggerPreCompact(
        'session-1',
        [],
        50000,
        20000
      );
      expect(result.shouldProceed).toBe(true);
    });

    it('should return preservedContext if available', async () => {
      const result = await manager.triggerPreCompact(
        'session-1',
        [],
        50000,
        20000
      );
      expect(result.preservedContext).toBeUndefined();
    });
  });
});

// ----------------------------------------------------------------------------
// Disabled State Tests
// ----------------------------------------------------------------------------

describe('HookManager disabled state', () => {
  it('should return allow result when disabled', async () => {
    const manager = new HookManager({
      workingDirectory: '/tmp',
      enabled: false,
    });
    await manager.initialize();

    const result = await manager.triggerPreToolUse('bash', 'rm -rf /', 'session-1');
    expect(result.shouldProceed).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.totalDuration).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Utility Methods Tests
// ----------------------------------------------------------------------------

describe('HookManager utility methods', () => {
  let manager: HookManager;

  beforeEach(async () => {
    manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();
  });

  describe('hasHooksFor', () => {
    it('should return false when no hooks configured', () => {
      expect(manager.hasHooksFor('PreToolUse')).toBe(false);
      expect(manager.hasHooksFor('SessionStart')).toBe(false);
    });
  });

  describe('getHookStats', () => {
    it('should return empty stats when no hooks configured', () => {
      const stats = manager.getHookStats();
      expect(stats).toEqual({});
    });
  });
});

// ----------------------------------------------------------------------------
// Factory Function Tests
// ----------------------------------------------------------------------------

describe('createHookManager', () => {
  it('should create a HookManager instance', () => {
    const manager = createHookManager({ workingDirectory: '/tmp' });
    expect(manager).toBeInstanceOf(HookManager);
  });
});
