// ============================================================================
// spawn_agent 空参数调用的可自纠错误消息
//
// 真机实测（2026-07-22 组队 dogfood）：GLM-5 偶发发出 arguments 为 {} 的
// spawn_agent 调用，落到单发分支报 "Task is required"——这条消息对「参数整个丢了」
// 的情形没有指向性，模型要多猜一轮。空参数时给出明确的重调用指令。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { executeSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnAgent';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

function makeContext(): SubagentExecutionContext {
  return {
    runId: 'run-empty-args',
    sessionId: 'session-empty-args',
    workspace: '/tmp',
    cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver: undefined,
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: new AbortController().signal,
    currentToolCallId: 'tool-empty-args',
  } as unknown as SubagentExecutionContext;
}

describe('spawn_agent 空参数', () => {
  it('arguments 为空时返回可直接照做的重调用指令', async () => {
    const result = await executeSpawnAgent({}, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('arguments 为空');
    expect(result.error).toContain('parallel=true');
    expect(result.error).toContain('agents');
  });

  it('有参数但缺 task 时保持原有英文提示（不误伤既有自纠路径）', async () => {
    const result = await executeSpawnAgent({ role: '溯真' }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Task is required');
  });
});
