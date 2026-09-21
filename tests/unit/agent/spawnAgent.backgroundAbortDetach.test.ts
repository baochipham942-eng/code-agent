// ============================================================================
// spawn_agent waitForCompletion:false 后台子代理不随工具调用收口被取消
//
// 回归（PR #2015 review）：引擎给每次工具调用派生独立 AbortController 并在 finally
// 无条件 abort；后台分支把子代理控制器挂在这个信号上，返回前不摘除的话，工具一收口
// 已报告「后台运行中」的子代理就被连带取消，wait_agent 只能拿到取消结果。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  executorExecute: vi.fn(),
  guardRegister: vi.fn(),
  guardAcquireSlot: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: harness.executorExecute }),
}));

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    getMaxDepth: () => 5,
    checkDepth: () => true,
    acquireSlot: harness.guardAcquireSlot,
    register: harness.guardRegister,
    getDisabledTools: () => [],
    getReadonlyDisabledTools: () => [],
    getRunningCount: () => 1,
  }),
}));

vi.mock('../../../src/host/agent/agentWorktree', () => ({
  cleanupAgentWorktree: vi.fn(),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(undefined),
  discardAgentWorktree: vi.fn(),
  resolveAgentWorktreeIsolation: vi.fn().mockResolvedValue('none'),
}));

vi.mock('../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground', () => ({
  adoptForegroundSubagent: vi.fn(),
  delegateSpawnAgentWorktreeCleanup: vi.fn(),
  finalizeForegroundSpawnAgentWorktree: vi.fn(),
  publishBackgroundSubagentVisibility: vi.fn(),
  raceForegroundBlockingBudget: vi.fn(),
  resolveForegroundBlockingBudgetMs: () => 600_000,
  resolveSingleSpawnRunScope: () => ({}),
  validateForegroundBlockingBudget: vi.fn(),
}));

vi.mock('../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ getModeForSession: () => 'development' }),
}));

vi.mock('../../../src/host/services/infra/fileOwnershipRegistry', () => ({
  bindFileOwnershipReleaseHook: vi.fn(),
}));

vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ getSessionState: () => ({ status: 'idle' }) }),
}));

import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

function makeContext(parentSignal: AbortSignal): SubagentExecutionContext {
  return {
    runId: 'run-bg-detach',
    sessionId: 'session-bg-detach',
    workspace: '/tmp',
    cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver: undefined,
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: parentSignal,
    currentToolCallId: 'tool-bg-detach',
  } as unknown as SubagentExecutionContext;
}

describe('spawn_agent waitForCompletion:false 后台分离', () => {
  afterEach(() => {
    harness.executorExecute.mockReset();
    harness.guardRegister.mockReset();
    harness.guardAcquireSlot.mockReset();
  });

  it('工具调用收口（父信号 abort）不连带取消已报告后台运行的子代理', async () => {
    // 子代理一直跑，永不 resolve（后台语义）。
    harness.executorExecute.mockReturnValue(new Promise(() => undefined));
    harness.guardAcquireSlot.mockResolvedValue({ release: vi.fn() });
    const parentController = new AbortController();

    const result = await executeSpawnAgent(
      { task: '后台验证任务', customPrompt: '你是后台验证代理', waitForCompletion: false },
      makeContext(parentController.signal),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('spawned in background');
    const subagentController = harness.guardRegister.mock.calls[0]?.[4] as AbortController | undefined;
    expect(subagentController).toBeInstanceOf(AbortController);

    // 模拟引擎 finally：工具调用收口时 abort 本次调用的信号。
    parentController.abort(new Error('tool execution settled'));

    expect(subagentController?.signal.aborted).toBe(false);
  });
});
