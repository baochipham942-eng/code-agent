import { beforeEach, describe, expect, it } from 'vitest';
import { useTurnExecutionStore } from '../../../src/renderer/stores/turnExecutionStore';

describe('turnExecutionStore', () => {
  beforeEach(() => {
    useTurnExecutionStore.getState().reset();
  });

  it('stores direct and auto routing evidence per session', () => {
    const store = useTurnExecutionStore.getState();

    store.recordRoutingEvidence('session-1', {
      kind: 'direct',
      mode: 'direct',
      timestamp: 100,
      turnMessageId: 'user-1',
      targetAgentIds: ['agent-reviewer'],
      targetAgentNames: ['reviewer'],
      deliveredTargetIds: ['agent-reviewer'],
      missingTargetIds: [],
    });
    store.recordRoutingEvidence('session-1', {
      kind: 'auto',
      mode: 'auto',
      timestamp: 120,
      agentId: 'default',
      agentName: 'default',
      reason: 'fallback',
      score: 0,
      fallbackToDefault: true,
    });

    expect(useTurnExecutionStore.getState().routingEventsBySession['session-1']).toEqual([
      expect.objectContaining({
        kind: 'direct',
        turnMessageId: 'user-1',
      }),
      expect.objectContaining({
        kind: 'auto',
        agentName: 'default',
        fallbackToDefault: true,
      }),
    ]);
  });

  it('stores hook activity per session', () => {
    const store = useTurnExecutionStore.getState();

    store.recordHookActivity('session-1', {
      timestamp: 140,
      event: 'PreToolUse',
      action: 'allow',
      durationMs: 6,
      hookCount: 1,
      modified: true,
      sources: ['project'],
      hookType: 'decision',
      toolName: 'Bash',
    });

    expect(useTurnExecutionStore.getState().hookEventsBySession['session-1']).toEqual([
      expect.objectContaining({
        event: 'PreToolUse',
        toolName: 'Bash',
        modified: true,
      }),
    ]);
  });

  it('tracks running hook batch and clears it when the paired trigger lands', () => {
    const store = useTurnExecutionStore.getState();

    store.recordHookStart('session-1', {
      timestamp: 130,
      event: 'PreToolUse',
      names: ['命令门禁'],
      toolName: 'Bash',
    });
    expect(useTurnExecutionStore.getState().hookRunningBySession['session-1']).toEqual(
      expect.objectContaining({ event: 'PreToolUse', names: ['命令门禁'] }),
    );

    store.recordHookActivity('session-1', {
      timestamp: 140,
      event: 'PreToolUse',
      action: 'allow',
      durationMs: 6,
      hookCount: 1,
      modified: false,
      sources: ['project'],
      hookType: 'decision',
      toolName: 'Bash',
    });
    expect(useTurnExecutionStore.getState().hookRunningBySession['session-1']).toBeUndefined();
  });

  it('clears running hook state on clearSession and reset', () => {
    const store = useTurnExecutionStore.getState();

    store.recordHookStart('session-1', { timestamp: 130, event: 'Stop' });
    store.recordHookStart('session-2', { timestamp: 131, event: 'Stop' });

    store.clearSession('session-1');
    expect(useTurnExecutionStore.getState().hookRunningBySession['session-1']).toBeUndefined();
    expect(useTurnExecutionStore.getState().hookRunningBySession['session-2']).toBeDefined();

    store.reset();
    expect(useTurnExecutionStore.getState().hookRunningBySession).toEqual({});
  });

  it('clearHookRunning 兜底：started 后配对 trigger 永不到达也能撤下（turn_end/终态路径调用）', () => {
    const store = useTurnExecutionStore.getState();

    store.recordHookStart('session-1', { timestamp: 130, event: 'PreToolUse', names: ['门禁'] });
    store.recordHookStart('session-2', { timestamp: 131, event: 'PreToolUse', names: ['门禁'] });

    store.clearHookRunning('session-1');
    expect(useTurnExecutionStore.getState().hookRunningBySession['session-1']).toBeUndefined();
    expect(useTurnExecutionStore.getState().hookRunningBySession['session-2']).toBeDefined();

    // 无记录时是 no-op：不换切片引用（zustand v5 裸 useSyncExternalStore 对引用敏感）
    const sliceBefore = useTurnExecutionStore.getState().hookRunningBySession;
    store.clearHookRunning('session-1');
    expect(useTurnExecutionStore.getState().hookRunningBySession).toBe(sliceBefore);
  });
});
