// ============================================================================
// agentBridge Tests (P2-A：forced-schema 校验接线)
//
// runAgentCall 的 schema 路径在调模型前必须先校验模型给的 schema：非对象型 schema 直接抛错、
// 不发起 inference（堵 deferred 审计：零校验直传 forced tool_choice inputSchema）。合法 schema
// 才走单轮 forced tool_choice 并取回 arguments。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const inferenceMock = vi.fn();
vi.mock('../../../../src/main/model/adapters/aiSdkAdapter', () => ({
  inferenceViaAiSdk: (...args: unknown[]) => inferenceMock(...args),
}));

// 共享 execute mock：agentBridge 模块加载时 new SubagentExecutor() 的实例 execute 惰性转发到它。
// vi.hoisted 让 mock 在 vi.mock 工厂（被提升）执行前就已初始化，避免 TDZ。
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock('../../../../src/main/agent/subagentExecutor', () => ({
  SubagentExecutor: class {
    execute = (...a: unknown[]) => executeMock(...a);
  },
}));

import { runAgentCall, type ScriptRunContext } from '../../../../src/main/agent/scriptRuntime/agentBridge';
import type { AgentCallPayload } from '../../../../src/main/agent/scriptRuntime/types';
import { BudgetTracker } from '../../../../src/main/agent/scriptRuntime/budget';

function makeCtx(budget: BudgetTracker = new BudgetTracker(null)): ScriptRunContext {
  const modelConfig = { provider: 'xiaomi', model: 'm', apiKey: 'k' } as never;
  return {
    runId: 'run1',
    baseModelConfig: modelConfig,
    resolveModelConfig: () => modelConfig,
    deriveSubagentContext: () => ({}) as never,
    defaultAgentTools: [],
    signal: new AbortController().signal,
    gate: { acquire: vi.fn(async () => () => {}) } as never,
    emit: vi.fn(),
    callCounter: { count: 0 },
    budget,
    now: () => 0,
  };
}

const VALID_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

beforeEach(() => {
  inferenceMock.mockReset();
  executeMock.mockReset();
});

describe('runAgentCall forced-schema 校验', () => {
  it('throws on a non-object schema and never calls inference', async () => {
    const ctx = makeCtx();
    const call: AgentCallPayload = { prompt: 'p', options: { schema: { type: 'array' } as never } };
    await expect(runAgentCall(call, ctx)).rejects.toThrow();
    expect(inferenceMock).not.toHaveBeenCalled();
  });

  it('runs forced tool_choice and returns the tool arguments for a valid schema', async () => {
    const ctx = makeCtx();
    inferenceMock.mockResolvedValue({
      toolCalls: [{ name: 'structured_output', arguments: { ok: true } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const call: AgentCallPayload = { prompt: 'p', options: { schema: VALID_SCHEMA as never } };
    const result = await runAgentCall(call, ctx);
    expect(result).toEqual({ ok: true });
    expect(inferenceMock).toHaveBeenCalledTimes(1);
    const opts = inferenceMock.mock.calls[0][5];
    expect(opts.toolChoice).toEqual({ type: 'tool', toolName: 'structured_output' });
  });
});

describe('runAgentCall token budget', () => {
  it('charges forced-path outputTokens to the budget', async () => {
    const budget = new BudgetTracker(1000);
    const ctx = makeCtx(budget);
    inferenceMock.mockResolvedValue({
      toolCalls: [{ name: 'structured_output', arguments: { ok: true } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx);
    expect(budget.spent()).toBe(5);
  });

  it('charges full-agent-path tokensUsed to the budget', async () => {
    const budget = new BudgetTracker(1000);
    const ctx = makeCtx(budget);
    executeMock.mockResolvedValue({ success: true, output: 'done', tokensUsed: 42 });
    const result = await runAgentCall({ prompt: 'p' }, ctx);
    expect(result).toBe('done');
    expect(budget.spent()).toBe(42);
  });

  it('throws before any inference when the budget is already exhausted', async () => {
    const budget = new BudgetTracker(100);
    budget.add(100);
    const ctx = makeCtx(budget);
    await expect(
      runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx),
    ).rejects.toThrow(/budget/i);
    expect(inferenceMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});
