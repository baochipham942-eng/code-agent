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

import { runAgentCall, type ScriptRunContext } from '../../../../src/main/agent/scriptRuntime/agentBridge';
import type { AgentCallPayload } from '../../../../src/main/agent/scriptRuntime/types';

function makeCtx(): ScriptRunContext {
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
    now: () => 0,
  };
}

const VALID_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

beforeEach(() => {
  inferenceMock.mockReset();
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
