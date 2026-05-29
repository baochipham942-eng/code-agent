// ============================================================================
// workflow (dynamic-workflow 命令层入口) Tests
//
// 覆盖 Codex audit (2026-05-29) 的 in-scope findings：
//   HIGH#2 runId 唯一性 / MED#1 model override 鉴权继承 / MED#3 startRun 抛错不崩
//   MED#2 派生 toolContext 隔离会话历史 / LOW#3 失败不发 completing 进度
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';
import type { ScriptRunSpec, ScriptRunState } from '../../../../../src/main/agent/scriptRuntime';
import type { ScriptRunHostDeps } from '../../../../../src/main/agent/scriptRuntime';

// ── mock 运行时 facade 的 startRun：捕获 spec/deps，返回可控终态 ──────────────
const startRunMock = vi.fn();
vi.mock('../../../../../src/main/agent/scriptRuntime', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/main/agent/scriptRuntime')>();
  return { ...actual, startRun: (spec: ScriptRunSpec, deps: ScriptRunHostDeps) => startRunMock(spec, deps) };
});

// ── mock per-call model 解析（模拟 configService 未初始化返回空 apiKey）──────────
const resolveSessionDefaultMock = vi.fn();
vi.mock('../../../../../src/main/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: (args: unknown) => resolveSessionDefaultMock(args),
}));

import { workflowModule } from '../../../../../src/main/tools/modules/multiagent/workflow';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const BASE_MODEL = { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: 'base-key', baseUrl: 'https://base' };

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'sess',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelConfig: { ...BASE_MODEL },
    resolver: { list: () => [], has: () => false, getDefinition: () => undefined, listDefinitions: () => [], execute: vi.fn() },
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function completedState(over: Partial<ScriptRunState> = {}): ScriptRunState {
  return { runId: 'x', status: 'completed', scriptHash: 'h', startedAt: 0, agentCallCount: 3, phases: ['p'], result: { ok: 1 }, ...over };
}

async function run(args: Record<string, unknown>, ctx: ToolContext = makeCtx(), canUseTool: CanUseToolFn = allowAll, onProgress?: (p: { stage: string; percent?: number }) => void) {
  const handler = await workflowModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  startRunMock.mockReset();
  resolveSessionDefaultMock.mockReset();
  startRunMock.mockResolvedValue(completedState());
});

describe('workflow tool', () => {
  it('schema metadata', () => {
    expect(workflowModule.schema.name).toBe('workflow');
    expect(workflowModule.schema.category).toBe('multiagent');
    expect(workflowModule.schema.inputSchema.required).toEqual(['script']);
  });

  it('rejects empty script with INVALID_ARGS', async () => {
    const r = await run({ script: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });

  it('NOT_INITIALIZED when no modelConfig', async () => {
    const r = await run({ script: 'return 1' }, makeCtx({ modelConfig: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_INITIALIZED');
  });

  // ── HIGH#2: runId 唯一 —— 同 session + 无 currentToolCallId 两次调用不得撞 ──
  it('generates a unique runId per invocation even without currentToolCallId', async () => {
    const ctx = makeCtx({ currentToolCallId: undefined });
    await run({ script: 'return 1' }, ctx);
    await run({ script: 'return 1' }, ctx);
    const id1 = (startRunMock.mock.calls[0][0] as ScriptRunSpec).runId;
    const id2 = (startRunMock.mock.calls[1][0] as ScriptRunSpec).runId;
    expect(id1).not.toBe(id2);
  });

  // ── MED#3: startRun 抛错 → 不炸出 handler，映射成结构化错误 ──
  it('does not crash when startRun throws; maps to error result', async () => {
    startRunMock.mockRejectedValue(new Error('worker boom'));
    const r = await run({ script: 'return 1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DOMAIN_ERROR');
      expect(r.error).toContain('worker boom');
    }
  });

  it('maps failed run state to DOMAIN_ERROR and cancelled to ABORTED', async () => {
    startRunMock.mockResolvedValue(completedState({ status: 'failed', error: 'bad', result: undefined }));
    const r1 = await run({ script: 'return 1' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('DOMAIN_ERROR');

    startRunMock.mockResolvedValue(completedState({ status: 'cancelled', error: 'stop', result: undefined }));
    const r2 = await run({ script: 'return 1' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('ABORTED');
  });

  // ── MED#1: model override 鉴权继承 —— 同 provider 下空 apiKey 回退 base ──
  it('inherits base apiKey when override resolves to empty key for same provider', async () => {
    resolveSessionDefaultMock.mockReturnValue({ provider: 'xiaomi', model: 'mimo-lite', apiKey: '', baseUrl: undefined });
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const resolved = deps.resolveModelConfig({ provider: 'xiaomi', model: 'mimo-lite' });
    expect(resolved.apiKey).toBe('base-key');
    expect(resolved.model).toBe('mimo-lite');
  });

  it('resolveModelConfig returns base config when no override', async () => {
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const resolved = deps.resolveModelConfig(undefined);
    expect(resolved.apiKey).toBe('base-key');
    expect(resolved.model).toBe('mimo-v2.5-pro');
  });

  // ── MED#2: 派生 SubagentContext 必须隔离会话历史，不随 legacyCtx 泄漏 ──
  it('derived subagent toolContext carries no conversation history', async () => {
    // ctx.subagent.messages 会经 buildLegacyCtxFromProtocol 进 legacyCtx.messages
    const ctx = makeCtx({ subagent: { messages: [{ role: 'user', content: 'secret history' }] } } as Partial<ToolContext>);
    await run({ script: 'return 1' }, ctx);
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const sub = deps.deriveSubagentContext({ agentId: 'a1', modelConfig: { ...BASE_MODEL }, signal: new AbortController().signal });
    const tc = sub.toolContext as Record<string, unknown>;
    expect(tc.messages).toBeUndefined();
    expect(tc.agentId).toBe('a1');
  });

  // ── LOW#3: 失败路径不发 completing 100% ──
  it('does not emit completing progress on failure', async () => {
    startRunMock.mockResolvedValue(completedState({ status: 'failed', error: 'bad', result: undefined }));
    const onProgress = vi.fn();
    await run({ script: 'return 1' }, makeCtx(), allowAll, onProgress);
    const completing = onProgress.mock.calls.find((c) => c[0]?.stage === 'completing');
    expect(completing).toBeUndefined();
  });

  it('happy path returns stringified result with meta', async () => {
    startRunMock.mockResolvedValue(completedState({ result: { answer: 42 }, agentCallCount: 5, phases: ['a', 'b'] }));
    const r = await run({ script: 'return {answer:42}', goal: 'g' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.output)).toEqual({ answer: 42 });
      expect(r.meta).toMatchObject({ agentCallCount: 5, phases: ['a', 'b'] });
    }
  });

  // ── Round 2 ──────────────────────────────────────────────────────────────

  // R2 MED: startRun 因取消抛 AbortError → 必须报 ABORTED 不是 DOMAIN_ERROR
  it('maps AbortError / aborted signal from startRun to ABORTED', async () => {
    const ctrl = new AbortController();
    startRunMock.mockImplementation(async () => {
      ctrl.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const r = await run({ script: 'return 1' }, makeCtx({ abortSignal: ctrl.signal }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABORTED');
  });

  // R2 MED: 同 provider override —— apiKey 有值但 baseUrl 缺失时必须继承 base 的 baseUrl
  it('inherits base baseUrl on same-provider override when resolved baseUrl missing', async () => {
    resolveSessionDefaultMock.mockReturnValue({ provider: 'xiaomi', model: 'mimo-lite', apiKey: 'own-key', baseUrl: undefined });
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const resolved = deps.resolveModelConfig({ provider: 'xiaomi', model: 'mimo-lite' });
    expect(resolved.apiKey).toBe('own-key');
    expect(resolved.baseUrl).toBe('https://base');
  });

  // R2 MED: 子上下文不得继承父 currentToolCallId（call-scoped id 串线）
  it('derived subagent toolContext does not carry parent currentToolCallId', async () => {
    const ctx = makeCtx({ currentToolCallId: 'parent-call-1' });
    await run({ script: 'return 1' }, ctx);
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const sub = deps.deriveSubagentContext({ agentId: 'a1', modelConfig: { ...BASE_MODEL }, signal: new AbortController().signal });
    expect((sub.toolContext as Record<string, unknown>).currentToolCallId).toBeUndefined();
  });

  // R2 MED: onProgress 抛错不得把成功 run 翻成失败（观测面 best-effort）
  it('a throwing onProgress does not turn a successful run into failure', async () => {
    const onProgress = vi.fn(() => { throw new Error('progress boom'); });
    const r = await run({ script: 'return 1' }, makeCtx(), allowAll, onProgress);
    expect(r.ok).toBe(true);
  });

  // R2 MED: canUseTool 等顶层调用抛错 → 不崩 handler，映射成结构化错误
  it('unexpected throw from canUseTool maps to error result, not crash', async () => {
    const throwingCanUse: CanUseToolFn = async () => { throw new Error('permission service down'); };
    const r = await run({ script: 'return 1' }, makeCtx(), throwingCanUse);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DOMAIN_ERROR');
  });
});
