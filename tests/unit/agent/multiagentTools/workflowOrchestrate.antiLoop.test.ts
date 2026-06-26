// ============================================================================
// Workflow Anti-Loop Tests — GAP-004: 多 Agent 流水线反死循环
// stage maxRetries 重试 / onFailureRoute 回退路由 / circuit breaker 跳闸
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';
import { WORKFLOW_ANTI_LOOP } from '../../../../src/shared/constants';

const { executeSubagentMock } = vi.hoisted(() => ({
  executeSubagentMock: vi.fn(),
}));

vi.mock('../../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executeSubagentMock,
  }),
}));

import { executeWorkflowOrchestrate } from '../../../../src/host/agent/multiagentTools/workflowOrchestrate';

function makeContext(overrides: Record<string, unknown> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/test',
    requestPermission: vi.fn(async () => true),
    modelConfig: {
      provider: 'zhipu',
      model: 'glm-5',
      temperature: 0.2,
    },
    ...overrides,
  } as unknown as ToolContext;
}

/** 让 mock 按 stage 名返回不同结果序列 */
function mockStageResults(plan: Record<string, Array<{ success: boolean; output?: string; error?: string }>>) {
  const callCounts: Record<string, number> = {};
  executeSubagentMock.mockImplementation(async (_prompt: string, config: { name: string }) => {
    // config.name 形如 "Stage:<stageName>"
    const stageName = config.name.replace(/^Stage:/, '');
    const sequence = plan[stageName] ?? [{ success: true, output: 'default-ok' }];
    const index = Math.min(callCounts[stageName] ?? 0, sequence.length - 1);
    callCounts[stageName] = (callCounts[stageName] ?? 0) + 1;
    const item = sequence[index];
    return {
      success: item.success,
      output: item.output ?? (item.success ? 'ok' : ''),
      error: item.error,
      toolsUsed: [],
    };
  });
  return callCounts;
}

function countStageCalls(stageName: string): number {
  return executeSubagentMock.mock.calls.filter(
    (call) => (call[1] as { name: string }).name === `Stage:${stageName}`,
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workflow anti-loop (GAP-004)', () => {
  it('retries a failing stage up to default maxRetries and succeeds', async () => {
    mockStageResults({
      Analyze: [{ success: true, output: 'analysis done' }],
      // 失败 2 次后第 3 次成功（默认 maxRetries=2 → 1 次初始 + 2 次重试）
      Fix: [
        { success: false, error: 'attempt 1 failed' },
        { success: false, error: 'attempt 2 failed' },
        { success: true, output: 'fixed' },
      ],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'anti-loop retry test',
        parallel: false,
        stages: [
          { name: 'Analyze', role: 'plan', prompt: 'Analyze the issue.' },
          { name: 'Fix', role: 'coder', prompt: 'Fix the issue.', dependsOn: ['Analyze'] },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(countStageCalls('Fix')).toBe(1 + WORKFLOW_ANTI_LOOP.DEFAULT_MAX_RETRIES);
  });

  it('honors stage-level maxRetries: 0 (no retry)', async () => {
    mockStageResults({
      Analyze: [{ success: true }],
      Fix: [{ success: false, error: 'always fails' }],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'no retry test',
        parallel: false,
        stages: [
          { name: 'Analyze', role: 'plan', prompt: 'Analyze.' },
          { name: 'Fix', role: 'coder', prompt: 'Fix.', dependsOn: ['Analyze'], maxRetries: 0 },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(countStageCalls('Fix')).toBe(1);
  });

  it('falls back to the upstream route stage after retries are exhausted', async () => {
    mockStageResults({
      // Analyze 第一次成功，回退重跑时也成功
      Analyze: [{ success: true, output: 'analysis v1' }, { success: true, output: 'analysis v2' }],
      // Verify 失败 2 次（重试耗尽）→ 回退 Analyze → 最后一次尝试成功
      Verify: [
        { success: false, error: 'verify failed 1' },
        { success: false, error: 'verify failed 2' },
        { success: true, output: 'verified after fallback' },
      ],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'fallback route test',
        parallel: false,
        stages: [
          { name: 'Analyze', role: 'plan', prompt: 'Analyze.' },
          {
            name: 'Verify',
            role: 'reviewer',
            prompt: 'Verify.',
            dependsOn: ['Analyze'],
            maxRetries: 1,
            onFailureRoute: 'Analyze',
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    // Analyze: 1 次初始 + 1 次回退重跑 = 2
    expect(countStageCalls('Analyze')).toBe(2);
    // Verify: 1 次初始 + 1 次重试 + 回退后最后 1 次 = 3
    expect(countStageCalls('Verify')).toBe(3);
  });

  it('trips the circuit breaker when total fallbacks exceed the limit and notifies the user', async () => {
    const emit = vi.fn();
    mockStageResults({
      Analyze: [{ success: true }, { success: true }, { success: true }],
      // 两个 verifier 都持续失败，各自触发回退 → 第二次回退超过 MAX_TOTAL_FALLBACKS=1 → 跳闸
      VerifyA: [{ success: false, error: 'A keeps failing' }],
      VerifyB: [{ success: false, error: 'B keeps failing' }],
      Final: [{ success: true }],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'circuit breaker test',
        parallel: false,
        stages: [
          { name: 'Analyze', role: 'plan', prompt: 'Analyze.' },
          {
            name: 'VerifyA',
            role: 'reviewer',
            prompt: 'Verify A.',
            dependsOn: ['Analyze'],
            maxRetries: 0,
            onFailureRoute: 'Analyze',
          },
          {
            name: 'VerifyB',
            role: 'reviewer',
            prompt: 'Verify B.',
            dependsOn: ['Analyze'],
            maxRetries: 0,
            onFailureRoute: 'Analyze',
          },
          { name: 'Final', role: 'coder', prompt: 'Finalize.', dependsOn: ['VerifyA', 'VerifyB'] },
        ],
      },
      makeContext({ emit }),
    );

    // workflow 整体失败且带 breaker 标记
    expect(result.success).toBe(false);
    expect(result.error).toContain('circuit breaker');
    expect(result.metadata).toMatchObject({ circuitBreakerTripped: true });
    // 剩余阶段（Final）未执行
    expect(countStageCalls('Final')).toBe(0);
    expect((result.metadata as { skippedStages: string[] }).skippedStages).toContain('Final');
    // 用户收到通知
    expect(emit).toHaveBeenCalledWith(
      'notification',
      expect.objectContaining({ message: expect.stringContaining('circuit breaker') }),
    );
  });

  it('keeps legacy behavior (failure does not block later stages) when breaker is not tripped', async () => {
    mockStageResults({
      Analyze: [{ success: true }],
      // Fix 没有 onFailureRoute → 重试耗尽后按失败返回，不触发 breaker
      Fix: [{ success: false, error: 'cannot fix' }],
      Report: [{ success: true, output: 'report done' }],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'legacy failure semantics',
        parallel: false,
        stages: [
          { name: 'Analyze', role: 'plan', prompt: 'Analyze.' },
          { name: 'Fix', role: 'coder', prompt: 'Fix.', dependsOn: ['Analyze'], maxRetries: 0 },
          // Report 不依赖 Fix，仍应执行
          { name: 'Report', role: 'writer', prompt: 'Report.', dependsOn: ['Analyze'] },
        ],
      },
      makeContext(),
    );

    // workflow 因 Fix 失败而整体不成功，但 Report 仍执行了
    expect(result.success).toBe(false);
    expect(countStageCalls('Report')).toBe(1);
    expect(result.metadata).not.toMatchObject({ circuitBreakerTripped: true });
  });

  it('skips fallback when onFailureRoute references a nonexistent stage', async () => {
    mockStageResults({
      Analyze: [{ success: true }],
      Verify: [{ success: false, error: 'fails' }],
    });

    const result = await executeWorkflowOrchestrate(
      {
        workflow: 'custom',
        task: 'invalid route test',
        parallel: false,
        stages: [
          { name: 'Analyze', role: 'plan', prompt: 'Analyze.' },
          {
            name: 'Verify',
            role: 'reviewer',
            prompt: 'Verify.',
            dependsOn: ['Analyze'],
            maxRetries: 0,
            onFailureRoute: 'DoesNotExist',
          },
        ],
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    // 无效路由 → 不回退，Analyze 只跑了 1 次
    expect(countStageCalls('Analyze')).toBe(1);
    expect(countStageCalls('Verify')).toBe(1);
  });
});
