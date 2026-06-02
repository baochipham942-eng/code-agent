// ============================================================================
// Hook Sanitization & Trace Entry Tests
// GAP-012: SubagentStop 注入 trace 查询入口（agentId + env vars）
// GAP-015: hook 观测日志（trigger history）密钥脱敏
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../../../src/main/hooks/hookManager';
import type { MergedHookConfig } from '../../../src/main/hooks/merger';
import { createHookEnvVars, type StopContext } from '../../../src/main/protocol/events';

vi.mock('../../../src/main/hooks/configParser', () => ({
  loadAllHooksConfig: vi.fn().mockResolvedValue([]),
  matchesCondition: vi.fn().mockReturnValue(true),
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

describe('SubagentStop trace query entry (GAP-012)', () => {
  let manager: HookManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();
  });

  it('records SubagentStop trigger when called with agentId', async () => {
    const result = await manager.triggerSubagentStop('code-review', 'review done', 'session-1', 'agent-42');

    expect(result.shouldProceed).toBe(true);
    const history = manager.getTriggerHistory();
    expect(history).toHaveLength(1);
    expect(history[0].event).toBe('SubagentStop');
  });

  it('passes agentId into the hook context for matching hooks', async () => {
    const { getHooksForEvent } = await import('../../../src/main/hooks/merger');
    // 用 command hook 验证 env vars（createHookEnvVars 从 context 取值）
    const matchingConfig: MergedHookConfig = {
      event: 'SubagentStop',
      hooks: [{ type: 'command', command: 'printf "type=$HOOK_SUBAGENT_TYPE id=$HOOK_SUBAGENT_ID"' }],
      sources: ['project'],
      parallel: false,
      hookType: 'observer',
    };
    vi.mocked(getHooksForEvent).mockReturnValue([matchingConfig]);

    const result = await manager.triggerSubagentStop('code-review', 'done', 'session-1', 'agent-42');

    // command hook 的 stdout 成为 message，应包含从 env vars 读到的 trace 查询入口
    expect(result.message).toContain('type=code-review');
    expect(result.message).toContain('id=agent-42');
  });

  it('exposes SUBAGENT_TYPE and SUBAGENT_ID env vars for SubagentStop context', () => {
    const context: StopContext = {
      event: 'SubagentStop',
      sessionId: 'session-1',
      timestamp: Date.now(),
      workingDirectory: '/tmp',
      response: 'done',
      subagentType: 'code-review',
      agentId: 'agent-42',
    };

    const env = createHookEnvVars(context);

    expect(env.HOOK_SUBAGENT_TYPE).toBe('code-review');
    expect(env.HOOK_SUBAGENT_ID).toBe('agent-42');
    expect(env.HOOK_SESSION_ID).toBe('session-1');
  });

  it('omits SUBAGENT_ID env var when agentId is not provided (backward compat)', () => {
    const context: StopContext = {
      event: 'SubagentStop',
      sessionId: 'session-1',
      timestamp: Date.now(),
      workingDirectory: '/tmp',
      subagentType: 'explore',
    };

    const env = createHookEnvVars(context);

    expect(env.HOOK_SUBAGENT_TYPE).toBe('explore');
    expect(env.HOOK_SUBAGENT_ID).toBeUndefined();
  });
});

describe('Hook trigger history sanitization (GAP-015)', () => {
  let manager: HookManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new HookManager({ workingDirectory: '/tmp' });
    await manager.initialize();
  });

  it('masks API keys in trigger history message', async () => {
    const { getHooksForEvent } = await import('../../../src/main/hooks/merger');
    const leakedKey = 'sk-ant-api03-' + 'a'.repeat(90);
    const matchingConfig: MergedHookConfig = {
      event: 'Stop',
      hooks: [{ type: 'command', command: `printf "found key: ${leakedKey}"` }],
      sources: ['project'],
      parallel: false,
      hookType: 'observer',
    };
    vi.mocked(getHooksForEvent).mockReturnValue([matchingConfig]);

    await manager.triggerStop('task done', 'session-1');

    const history = manager.getTriggerHistory();
    expect(history).toHaveLength(1);
    // 观测日志中的密钥被脱敏
    expect(history[0].message).toBeDefined();
    expect(history[0].message).not.toContain(leakedKey);
  });

  it('keeps non-sensitive messages intact in trigger history', async () => {
    const { getHooksForEvent } = await import('../../../src/main/hooks/merger');
    const matchingConfig: MergedHookConfig = {
      event: 'Stop',
      hooks: [{ type: 'command', command: 'printf "lint passed: 0 errors"' }],
      sources: ['project'],
      parallel: false,
      hookType: 'observer',
    };
    vi.mocked(getHooksForEvent).mockReturnValue([matchingConfig]);

    await manager.triggerStop('task done', 'session-1');

    const history = manager.getTriggerHistory();
    expect(history[0].message).toBe('lint passed: 0 errors');
  });

  it('onTrigger observer also receives the masked message', async () => {
    const { getHooksForEvent } = await import('../../../src/main/hooks/merger');
    const leakedKey = 'ghp_' + 'b'.repeat(40);
    const onTrigger = vi.fn();
    const observed = new HookManager({ workingDirectory: '/tmp', onTrigger });
    await observed.initialize();

    const matchingConfig: MergedHookConfig = {
      event: 'Stop',
      hooks: [{ type: 'command', command: `printf "token: ${leakedKey}"` }],
      sources: ['project'],
      parallel: false,
      hookType: 'observer',
    };
    vi.mocked(getHooksForEvent).mockReturnValue([matchingConfig]);

    await observed.triggerStop('done', 'session-1');

    expect(onTrigger).toHaveBeenCalled();
    const entry = onTrigger.mock.calls[0][0];
    expect(entry.message).not.toContain(leakedKey);
  });
});
