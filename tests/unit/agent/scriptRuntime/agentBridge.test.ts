// ============================================================================
// agentBridge Tests (P2-A：forced-schema 校验接线)
//
// runAgentCall 的 schema 路径在调模型前必须先校验模型给的 schema：非对象型 schema 直接抛错、
// 不发起 inference（堵 deferred 审计：零校验直传 forced tool_choice inputSchema）。合法 schema
// 才走单轮 forced tool_choice 并取回 arguments。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const inferenceMock = vi.fn();
vi.mock('../../../../src/host/model/adapters/aiSdkAdapter', () => ({
  inferenceViaAiSdk: (...args: unknown[]) => inferenceMock(...args),
}));

// 共享 execute mock：agentBridge 模块加载时 new SubagentExecutor() 的实例 execute 惰性转发到它。
// vi.hoisted 让 mock 在 vi.mock 工厂（被提升）执行前就已初始化，避免 TDZ。
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock('../../../../src/host/agent/subagentExecutor', () => ({
  SubagentExecutor: class {
    execute = (...a: unknown[]) => executeMock(...a);
  },
}));

import { runAgentCall, type ScriptRunContext } from '../../../../src/host/agent/scriptRuntime/agentBridge';
import type { AgentCallPayload } from '../../../../src/host/agent/scriptRuntime/types';
import { BudgetTracker } from '../../../../src/host/agent/scriptRuntime/budget';
import { resolveToolProfile } from '../../../../src/host/agent/scriptRuntime/toolProfiles';
import { SerialWriteGate } from '../../../../src/host/agent/scriptRuntime/writeGate';

function makeCtx(budget: BudgetTracker = new BudgetTracker(null)): ScriptRunContext {
  const modelConfig = { provider: 'xiaomi', model: 'm', apiKey: 'k' } as never;
  return {
    runId: 'run1',
    runInputHash: 'goal-default',
    baseModelConfig: modelConfig,
    resolveModelConfig: () => modelConfig,
    deriveSubagentContext: () => ({}) as never,
    resolveAgentTools: (p?: string) => resolveToolProfile(p),
    writeGuard: { inFlight: 0, warned: false },
    writeGate: new SerialWriteGate(),
    signal: new AbortController().signal,
    gate: { acquire: vi.fn(async () => () => {}) } as never,
    emit: vi.fn(),
    callCounter: { count: 0 },
    cacheHitCounter: { count: 0 },
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

  it('charges forced-path outputTokens even when the model returns no tool call (HIGH#2)', async () => {
    const budget = new BudgetTracker(1000);
    const ctx = makeCtx(budget);
    inferenceMock.mockResolvedValue({ toolCalls: [], usage: { inputTokens: 3, outputTokens: 7 } });
    await expect(
      runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx),
    ).rejects.toThrow();
    expect(budget.spent()).toBe(7); // 失败也要入账已消耗的 token
  });

  it('charges full-agent tokensUsed even when the sub-agent fails (HIGH#2)', async () => {
    const budget = new BudgetTracker(1000);
    const ctx = makeCtx(budget);
    executeMock.mockResolvedValue({ success: false, error: 'boom', tokensUsed: 13 });
    await expect(runAgentCall({ prompt: 'p' }, ctx)).rejects.toThrow(/boom/);
    expect(budget.spent()).toBe(13);
  });

  it('charges tokens carried on a thrown execute() error (Codex R2 MED#4)', async () => {
    const budget = new BudgetTracker(1000);
    const ctx = makeCtx(budget);
    const err = Object.assign(new Error('stream blew up'), { tokensUsed: 17 });
    executeMock.mockRejectedValue(err);
    await expect(runAgentCall({ prompt: 'p' }, ctx)).rejects.toThrow(/blew up/);
    expect(budget.spent()).toBe(17); // provider 抛错前已产出的 output 也要记账
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

  // ── Codex R2 HIGH#1：预算在 gate 等待期间被耗尽 → acquire 后的权威 check 拦下，且释放 gate ──
  it('re-checks budget after acquiring the gate and releases the slot on rejection', async () => {
    const budget = new BudgetTracker(100); // 顶部预检时 spent=0 放行
    const release = vi.fn();
    const ctx = makeCtx(budget);
    ctx.gate = {
      acquire: vi.fn(async () => {
        budget.add(100); // 模拟等待期间并发把预算推满
        return release;
      }),
    } as never;
    await expect(
      runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx),
    ).rejects.toThrow(/budget/i);
    expect(inferenceMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1); // gate 槽必须释放
  });
});

describe('runAgentCall 进度事件 enrich（P3a 进度树）', () => {
  type EmittedEvent = { type: string; data?: Record<string, unknown> };
  const emittedOfType = (ctx: ScriptRunContext, type: string): EmittedEvent | undefined =>
    (ctx.emit as ReturnType<typeof vi.fn>).mock.calls
      .map(([e]: [EmittedEvent]) => e)
      .find((e) => e.type === type);

  it('agent:start 携带 phase 与 promptPreview（供进度树分组 + 显示在做什么）', async () => {
    const ctx = makeCtx();
    inferenceMock.mockResolvedValue({
      toolCalls: [{ name: 'structured_output', arguments: { ok: true } }],
      usage: { outputTokens: 1 },
    });
    await runAgentCall(
      { prompt: '搜索 Rust 异步运行时的调度模型', options: { schema: VALID_SCHEMA as never, phase: 'investigate', label: 'find' } },
      ctx,
    );
    const start = emittedOfType(ctx, 'agent:start');
    expect(start?.data?.phase).toBe('investigate');
    expect(start?.data?.promptPreview).toContain('Rust 异步运行时');
  });

  it('promptPreview 截断超长 prompt（不把整段灌进事件）', async () => {
    const ctx = makeCtx();
    executeMock.mockResolvedValue({ success: true, output: 'ok' });
    const longPrompt = 'x'.repeat(500);
    await runAgentCall({ prompt: longPrompt }, ctx);
    const start = emittedOfType(ctx, 'agent:start');
    const preview = start?.data?.promptPreview as string;
    expect(preview.length).toBeLessThan(longPrompt.length);
  });

  it('agent:done 携带 resultPreview（full-agent 文本结果）', async () => {
    const ctx = makeCtx();
    executeMock.mockResolvedValue({ success: true, output: '找到 3 条线索' });
    await runAgentCall({ prompt: 'p' }, ctx);
    const done = emittedOfType(ctx, 'agent:done');
    expect(done?.data?.resultPreview).toContain('找到 3 条线索');
  });

  it('agent:done 携带 resultPreview（forced 结构化结果序列化预览）', async () => {
    const ctx = makeCtx();
    inferenceMock.mockResolvedValue({
      toolCalls: [{ name: 'structured_output', arguments: { finding: 'tokio', confidence: 0.9 } }],
      usage: { outputTokens: 1 },
    });
    await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx);
    const done = emittedOfType(ctx, 'agent:done');
    expect(done?.data?.resultPreview).toContain('tokio');
  });
});

describe('runAgentCall 工具分档 + 并行写护栏', () => {
  it('defaults the full-agent path to readonly tools (no write tools)', async () => {
    const ctx = makeCtx();
    executeMock.mockResolvedValue({ success: true, output: 'ok' });
    await runAgentCall({ prompt: 'p' }, ctx);
    const config = executeMock.mock.calls[0][1] as { availableTools: string[] };
    expect(config.availableTools).toEqual(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
  });

  it('passes the resolved tool list for the requested profile', async () => {
    const ctx = makeCtx();
    executeMock.mockResolvedValue({ success: true, output: 'ok' });
    await runAgentCall({ prompt: 'p', options: { tools: 'edit' } }, ctx);
    const config = executeMock.mock.calls[0][1] as { availableTools: string[] };
    expect(config.availableTools).toContain('Edit');
    expect(config.availableTools).toContain('Write');
    expect(config.availableTools).not.toContain('Bash');
  });

  it('warns once when a write-capable agent runs while another writer is in flight', async () => {
    const ctx = makeCtx();
    ctx.writeGuard.inFlight = 1; // 模拟已有一个写 agent 在跑
    executeMock.mockResolvedValue({ success: true, output: 'ok' });
    await runAgentCall({ prompt: 'p', options: { tools: 'edit' } }, ctx);
    const warned = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.some(
      ([e]: [{ type: string; data?: { message?: string } }]) =>
        e.type === 'run:log' && /多个写 agent|串行执行|互相覆盖/.test(e.data?.message ?? ''),
    );
    expect(warned).toBe(true);
    expect(ctx.writeGuard.warned).toBe(true);
  });

  it('does not warn for readonly agents even when one is in flight', async () => {
    const ctx = makeCtx();
    ctx.writeGuard.inFlight = 1;
    executeMock.mockResolvedValue({ success: true, output: 'ok' });
    await runAgentCall({ prompt: 'p' }, ctx); // readonly
    expect(ctx.writeGuard.warned).toBe(false);
  });

  it('serializes write-capable agents that share the same worktree', async () => {
    const ctx = makeCtx();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    executeMock.mockImplementation((prompt: string) => {
      events.push(`start:${prompt}`);
      if (prompt === 'first writer') {
        return new Promise((resolve) => {
          releaseFirst = () => {
            events.push('finish:first writer');
            resolve({ success: true, output: 'first done' });
          };
        });
      }
      events.push(`finish:${prompt}`);
      return Promise.resolve({ success: true, output: 'second done' });
    });

    const first = runAgentCall({ prompt: 'first writer', options: { tools: 'edit' } }, ctx);
    await vi.waitFor(() => {
      expect(events).toEqual(['start:first writer']);
      expect(ctx.writeGate.stats()).toMatchObject({ inFlight: 1 });
    });

    const second = runAgentCall({ prompt: 'second writer', options: { tools: 'edit' } }, ctx);
    await Promise.resolve();
    expect(events).toEqual(['start:first writer']);
    expect(ctx.writeGate.stats()).toMatchObject({ inFlight: 1, queued: 1 });

    releaseFirst?.();
    await expect(first).resolves.toBe('first done');
    await expect(second).resolves.toBe('second done');
    expect(events).toEqual([
      'start:first writer',
      'finish:first writer',
      'start:second writer',
      'finish:second writer',
    ]);
  });
});

describe('runAgentCall resumable 缓存（P4-C）', () => {
  type Rec = { callIndex: number; contentHash: string; result: unknown; tokensUsed: number };
  const eventOfType = (ctx: ScriptRunContext, type: string) =>
    (ctx.emit as ReturnType<typeof vi.fn>).mock.calls
      .map(([e]: [{ type: string; data?: Record<string, unknown> }]) => e)
      .find((e) => e.type === type);

  it('records a successful live call via recordCall (callIndex + contentHash + tokens)', async () => {
    const ctx = makeCtx(new BudgetTracker(1000));
    const recorded: Rec[] = [];
    ctx.recordCall = (r) => recorded.push(r as Rec);
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: true } }], usage: { outputTokens: 5 } });
    await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ callIndex: 1, tokensUsed: 5, result: { ok: true } });
    expect(typeof recorded[0].contentHash).toBe('string');
  });

  it('cache hit: returns stored result, no inference, 0 budget, copies into this run journal, marks cached', async () => {
    // 先 live 跑一次拿真实 contentHash（不写死 hash 算法）
    const ctx1 = makeCtx(new BudgetTracker(1000));
    const rec1: Rec[] = [];
    ctx1.recordCall = (r) => rec1.push(r as Rec);
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: true } }], usage: { outputTokens: 5 } });
    await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx1);
    const hash = rec1[0].contentHash;

    inferenceMock.mockReset();
    executeMock.mockReset();
    const budget2 = new BudgetTracker(1000);
    const ctx2 = makeCtx(budget2);
    const rec2: Rec[] = [];
    ctx2.recordCall = (r) => rec2.push(r as Rec);
    ctx2.resumeCalls = new Map([[1, { contentHash: hash, result: { ok: true } }]]);

    const result = await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx2);
    expect(result).toEqual({ ok: true });
    expect(inferenceMock).not.toHaveBeenCalled();
    expect(budget2.spent()).toBe(0);
    expect(rec2).toHaveLength(1);
    expect(rec2[0]).toMatchObject({ callIndex: 1, tokensUsed: 0, result: { ok: true } });
    expect(eventOfType(ctx2, 'agent:start')?.data?.cached).toBe(true);
    expect(eventOfType(ctx2, 'agent:done')?.data?.cached).toBe(true);
    expect(ctx2.gate.acquire).not.toHaveBeenCalled(); // 命中不占 gate
  });

  it('cache miss on content change: runs live and ignores the stale cached entry', async () => {
    const budget = new BudgetTracker(1000);
    const ctx = makeCtx(budget);
    ctx.resumeCalls = new Map([[1, { contentHash: 'STALE', result: { ok: true } }]]);
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: false } }], usage: { outputTokens: 9 } });
    const result = await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx);
    expect(inferenceMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false });
    expect(budget.spent()).toBe(9);
  });

  it('cache hit is NOT blocked by an exhausted budget (cached calls cost nothing)', async () => {
    const ctxL = makeCtx(new BudgetTracker(1000));
    const recL: Rec[] = [];
    ctxL.recordCall = (r) => recL.push(r as Rec);
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: true } }], usage: { outputTokens: 5 } });
    await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctxL);
    const hash = recL[0].contentHash;

    inferenceMock.mockReset();
    const budget = new BudgetTracker(100);
    budget.add(100); // 预算耗尽
    const ctx = makeCtx(budget);
    ctx.resumeCalls = new Map([[1, { contentHash: hash, result: { ok: true } }]]);
    const result = await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never } }, ctx);
    expect(result).toEqual({ ok: true });
    expect(inferenceMock).not.toHaveBeenCalled();
  });

  // ── Codex round1 HIGH#1：resolved 默认 model 必须进 hash，否则换主模型仍误命中旧结果 ──
  it('cache MISS when the resolved default model differs (no per-call model override)', async () => {
    const VS = VALID_SCHEMA as never;
    // run1：默认 model = A，live 跑拿 hash
    const ctxA = makeCtx();
    ctxA.resolveModelConfig = () => ({ provider: 'xiaomi', model: 'model-A', apiKey: 'k' }) as never;
    const recA: Rec[] = [];
    ctxA.recordCall = (r) => recA.push(r as Rec);
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: true } }], usage: { outputTokens: 5 } });
    await runAgentCall({ prompt: 'p', options: { schema: VS } }, ctxA);
    const hashA = recA[0].contentHash;

    // run2：默认 model 换成 B，seed 旧 hash → 必须 MISS（resolved model 不同）→ live 重跑
    inferenceMock.mockReset();
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: false } }], usage: { outputTokens: 7 } });
    const ctxB = makeCtx();
    ctxB.resolveModelConfig = () => ({ provider: 'xiaomi', model: 'model-B', apiKey: 'k' }) as never;
    ctxB.resumeCalls = new Map([[1, { contentHash: hashA, result: { ok: true } }]]);
    const result = await runAgentCall({ prompt: 'p', options: { schema: VS } }, ctxB);
    expect(inferenceMock).toHaveBeenCalledTimes(1); // 没命中 → live
    expect(result).toEqual({ ok: false });
  });

  // ── Codex round1 MED#2：循环 schema 不得在 computeCallHash 爆栈，应走干净校验拒绝 ──
  it('cyclic schema fails with a clean validation error, not a stack overflow', async () => {
    const ctx = makeCtx();
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    await expect(runAgentCall({ prompt: 'p', options: { schema: cyclic as never } }, ctx)).rejects.toThrow(/schema|非法|序列化/);
    expect(inferenceMock).not.toHaveBeenCalled();
  });

  it('relabeling a call (label/phase only) still hits cache — display fields are not in the content hash', async () => {
    const ctx1 = makeCtx();
    const rec1: Rec[] = [];
    ctx1.recordCall = (r) => rec1.push(r as Rec);
    inferenceMock.mockResolvedValue({ toolCalls: [{ name: 'structured_output', arguments: { ok: true } }], usage: { outputTokens: 5 } });
    await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never, label: 'old', phase: 'A' } }, ctx1);
    const hash = rec1[0].contentHash;

    inferenceMock.mockReset();
    const ctx2 = makeCtx();
    ctx2.resumeCalls = new Map([[1, { contentHash: hash, result: { ok: true } }]]);
    // 只改 label/phase，prompt + schema 不变 → 仍命中
    const result = await runAgentCall({ prompt: 'p', options: { schema: VALID_SCHEMA as never, label: 'new', phase: 'B' } }, ctx2);
    expect(result).toEqual({ ok: true });
    expect(inferenceMock).not.toHaveBeenCalled();
  });
});
