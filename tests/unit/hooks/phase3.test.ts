// ============================================================================
// Phase 3 Hook Tests
// Tests for: trigger history, observer downgrade, new trigger methods
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../../../src/main/hooks/hookManager';


// Mock dependencies
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
// Trigger History Tests
// ----------------------------------------------------------------------------

describe('Trigger History', () => {
  let manager: HookManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();
  });

  it('should start with empty history', () => {
    const history = manager.getTriggerHistory();
    expect(history).toEqual([]);
  });

  it('should record triggers after hook execution', async () => {
    await manager.triggerPreToolUse('bash', 'echo test', 'session-1');

    const history = manager.getTriggerHistory();
    expect(history).toHaveLength(1);
    expect(history[0].event).toBe('PreToolUse');
    expect(history[0].action).toBe('allow');
    expect(history[0].hookCount).toBe(0);
    expect(history[0].modified).toBe(false);
    expect(history[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(history[0].timestamp).toBeGreaterThan(0);
  });

  it('should record multiple triggers in order', async () => {
    await manager.triggerPreToolUse('bash', 'echo 1', 'session-1');
    await manager.triggerPostToolUse('bash', 'echo 1', 'output', 'session-1');
    await manager.triggerStop('done', 'session-1');

    const history = manager.getTriggerHistory();
    expect(history).toHaveLength(3);
    expect(history[0].event).toBe('PreToolUse');
    expect(history[1].event).toBe('PostToolUse');
    expect(history[2].event).toBe('Stop');
  });

  it('should cap history at 50 entries', async () => {
    // Fire 55 triggers
    for (let i = 0; i < 55; i++) {
      await manager.triggerPreToolUse('bash', `cmd-${i}`, 'session-1');
    }

    const history = manager.getTriggerHistory();
    expect(history).toHaveLength(50);
    // Oldest entries should have been evicted
    // The first remaining entry should be from i=5 (entries 0-4 evicted)
  });

  it('should not record triggers when manager is disabled', async () => {
    const disabled = new HookManager({ workingDirectory: '/tmp', enabled: false });
    await disabled.initialize();

    await disabled.triggerPreToolUse('bash', 'echo test', 'session-1');

    expect(disabled.getTriggerHistory()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// New Trigger Methods Tests (Phase 3)
// ----------------------------------------------------------------------------

describe('Phase 3 Trigger Methods', () => {
  let manager: HookManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();
  });

  describe('triggerPermissionDenied', () => {
    it('should return allow result (observer-only event)', async () => {
      const result = await manager.triggerPermissionDenied(
        'bash', 'security policy', 'policy', 'session-1'
      );
      expect(result.shouldProceed).toBe(true);
    });

    it('should record in trigger history', async () => {
      await manager.triggerPermissionDenied(
        'bash', 'user rejected', 'user', 'session-1'
      );
      const history = manager.getTriggerHistory();
      expect(history).toHaveLength(1);
      expect(history[0].event).toBe('PermissionDenied');
    });
  });

  describe('triggerPostCompact', () => {
    it('should return allow result (observer-only event)', async () => {
      const result = await manager.triggerPostCompact(
        5000, 'ai_summary', 'session-1'
      );
      expect(result.shouldProceed).toBe(true);
    });

    it('should record in trigger history', async () => {
      await manager.triggerPostCompact(5000, 'truncate', 'session-1');
      const history = manager.getTriggerHistory();
      expect(history).toHaveLength(1);
      expect(history[0].event).toBe('PostCompact');
    });
  });

  describe('triggerStopFailure', () => {
    it('should return allow result (observer-only event)', async () => {
      const result = await manager.triggerStopFailure(
        'Circuit breaker tripped', 'circuit_breaker', 'session-1'
      );
      expect(result.shouldProceed).toBe(true);
    });

    it('should record in trigger history', async () => {
      await manager.triggerStopFailure(
        'Max iterations reached', 'max_iterations', 'session-1'
      );
      const history = manager.getTriggerHistory();
      expect(history).toHaveLength(1);
      expect(history[0].event).toBe('StopFailure');
    });
  });
});

// ----------------------------------------------------------------------------
// Observer Downgrade Tests
// ----------------------------------------------------------------------------

describe('Observer Downgrade in configParser', () => {
  it('should downgrade decision hooks on observer-only events', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const { parseHooksConfig } = await import('../../../src/main/hooks/configParser');

    vi.unmock('../../../src/main/hooks/configParser');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-observer-test-'));
    const configFile = path.join(tempDir, 'settings.json');

    // Configure a decision hook on PostToolUse (observer-only event)
    const config = {
      hooks: {
        PostToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo blocked' }],
            hookType: 'decision',
          },
        ],
        PermissionDenied: [
          {
            hooks: [{ type: 'command', command: 'echo denied' }],
            hookType: 'decision',
          },
        ],
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(config));

    const result = await parseHooksConfig(configFile, 'project');

    // Both should be downgraded to observer
    const postToolUse = result.find(r => r.event === 'PostToolUse');
    expect(postToolUse?.hookType).toBe('observer');

    const permDenied = result.find(r => r.event === 'PermissionDenied');
    expect(permDenied?.hookType).toBe('observer');

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

// ----------------------------------------------------------------------------
// getHookStats Tests
// ----------------------------------------------------------------------------

describe('getHookStats', () => {
  it('should return empty stats when no hooks configured', async () => {
    const manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();

    const stats = manager.getHookStats();
    expect(stats).toEqual({});
  });
});
