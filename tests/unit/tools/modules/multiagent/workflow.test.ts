// ============================================================================
// workflow (dynamic-workflow 命令层入口) Tests
//
// 覆盖 Codex audit (2026-05-29) 的 in-scope findings：
//   HIGH#2 runId 唯一性 / MED#1 model override 鉴权继承 / MED#3 startRun 抛错不崩
//   MED#2 派生 toolContext 隔离会话历史 / LOW#3 失败不发 completing 进度
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import type { ScriptRunSpec, ScriptRunState } from '../../../../../src/host/agent/scriptRuntime';
import type { ScriptRunHostDeps } from '../../../../../src/host/agent/scriptRuntime';
import { ORCHESTRATION_CAPABILITIES } from '../../../../../src/host/agent/scriptRuntime/capabilityManifest';

// ── mock 运行时 facade 的 startRun：捕获 spec/deps，返回可控终态 ──────────────
const startRunMock = vi.fn();
vi.mock('../../../../../src/host/agent/scriptRuntime', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/scriptRuntime')>();
  return { ...actual, startRun: (spec: ScriptRunSpec, deps: ScriptRunHostDeps) => startRunMock(spec, deps) };
});

// ── mock per-call model 解析（模拟 configService 未初始化返回空 apiKey）──────────
const resolveSessionDefaultMock = vi.fn();
vi.mock('../../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: (args: unknown) => resolveSessionDefaultMock(args),
}));

// ── mock EventBus：捕获 emit → 'workflow' domain 的 publish（P3a 进度树事件通道）──
const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock('../../../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => ({ publish: publishMock }),
}));

// ── mock 审批闸（P3b）：默认批准；单测可切 approved=false 验证拒绝时不 startRun ──
const { approvalHolder } = vi.hoisted(() => ({ approvalHolder: { approved: true } }));
vi.mock('../../../../../src/host/agent/workflowLaunchApproval', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/workflowLaunchApproval')>();
  return {
    ...actual,
    getWorkflowLaunchApprovalGate: () => ({
      requestApproval: async ({ request }: { request: unknown }) => ({
        approved: approvalHolder.approved,
        autoApproved: true,
        feedback: approvalHolder.approved ? undefined : '用户拒绝',
        request,
      }),
    }),
  };
});

import { workflowModule } from '../../../../../src/host/tools/modules/multiagent/workflow';

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
  return { runId: 'x', status: 'completed', scriptHash: 'h', startedAt: 0, agentCallCount: 3, tokensSpent: 0, cacheHits: 0, phases: ['p'], result: { ok: 1 }, ...over };
}

async function run(args: Record<string, unknown>, ctx: ToolContext = makeCtx(), canUseTool: CanUseToolFn = allowAll, onProgress?: (p: { stage: string; percent?: number }) => void) {
  const handler = await workflowModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  startRunMock.mockReset();
  resolveSessionDefaultMock.mockReset();
  publishMock.mockReset();
  approvalHolder.approved = true;
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

  // ── P2-A: 主线程 fail-fast —— 语法错脚本不进 worker，归 INVALID_ARGS ──
  it('rejects a syntactically invalid script with INVALID_ARGS and never starts a run', async () => {
    const r = await run({ script: 'const x = ;' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    expect(startRunMock).not.toHaveBeenCalled();
  });

  // ── P2-A: export 声明（meta 格式留 P3）被拒，不进 worker ──
  it('rejects a script with an export declaration with INVALID_ARGS', async () => {
    const r = await run({ script: 'export const meta = { name: "x" };\nreturn 1;' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    expect(startRunMock).not.toHaveBeenCalled();
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

  // ── MED#2: 派生 SubagentContext 必须隔离会话历史 ──
  it('derived subagent context carries no conversation history', async () => {
    // ctx.subagent.messages 会经 buildLegacyCtxFromProtocol 进 legacyCtx.messages
    const ctx = makeCtx({ subagent: { messages: [{ role: 'user', content: 'secret history' }] } } as Partial<ToolContext>);
    await run({ script: 'return 1' }, ctx);
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const sub = deps.deriveSubagentContext({ agentId: 'a1', modelConfig: { ...BASE_MODEL }, signal: new AbortController().signal, capabilities: ORCHESTRATION_CAPABILITIES });
    expect(sub.messages).toBeUndefined();
    expect(sub.agentId).toBe('a1');
  });

  it('pins a writer child to its isolated worktree workspace and cwd', async () => {
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const signal = new AbortController().signal;
    const sub = deps.deriveSubagentContext({
      agentId: 'writer-a1',
      modelConfig: { ...BASE_MODEL },
      signal,
      capabilities: {
        fileRead: true,
        fileWrite: true,
        shell: false,
        network: true,
        credential: false,
        childProcess: false,
      },
      workspace: {
        cwd: '/tmp/writer-a1',
        workspace: '/tmp/writer-a1',
        repoPath: '/repo',
        branchName: 'agent/writer-a1',
      },
    });
    expect(sub.worktreePath).toBe('/tmp/writer-a1');
    expect(sub.cwd).toBe('/tmp/writer-a1');
    expect(sub.workspace).toBe('/tmp/writer-a1');
    expect(sub.capabilityManifest).toMatchObject({ fileWrite: true, credential: false });
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

  it('delivers completed script output while surfacing unknown nested side effects for review', async () => {
    startRunMock.mockImplementation(async (rawSpec: ScriptRunSpec, deps: ScriptRunHostDeps) => {
      const nested = rawSpec.nestedGraph!;
      deps.emitNestedGraph?.({
        type: 'nested:node_failed',
        timestamp: 123,
        error: 'agent failed after an uncertain write',
        metadata: {
          protocolVersion: nested.protocolVersion,
          workflowRunId: nested.workflowRunId,
          parentGraphId: nested.parentGraphId,
          parentNodeId: nested.parentNodeId,
          nestedGraphId: nested.nestedGraphId,
          groupId: 'parallel-group',
          groupKind: 'parallel',
          itemId: 'risky-agent',
          nodeId: 'parallel-node:risky-agent',
          dependencyNodeIds: [],
          callIndex: 0,
          sideEffect: 'unknown',
        },
      });
      return completedState({
        result: { retained: 'script result' },
        tokensSpent: 321,
        phases: ['fan-out', 'synthesis'],
      });
    });

    const r = await run({
      script: 'const values = await parallel([() => agent("risky")]); return values;',
    });

    expect(r.ok, r.ok ? undefined : `${r.code}: ${r.error}`).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.output)).toEqual({ retained: 'script result' });
      expect(r.meta).toMatchObject({
        tokensSpent: 321,
        phases: ['fan-out', 'synthesis'],
        graphCheckpoint: {
          status: 'requires_review',
          nodes: [{
            status: 'requires_review',
            result: { status: 'requires_review', sideEffectState: 'unknown' },
          }],
        },
      });
    }
  });

  // ── P3b: 启动审批闸 —— 拒绝时不得 startRun，归 ABORTED ──
  it('aborts before startRun when the launch approval is rejected', async () => {
    approvalHolder.approved = false;
    const r = await run({ script: "phase('p'); return 1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABORTED');
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it('proceeds to startRun when the launch approval is granted', async () => {
    approvalHolder.approved = true;
    const r = await run({ script: "phase('p'); return 1" });
    expect(r.ok).toBe(true);
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });

  // ── P3a: 进度树事件通道 —— emit 把 ScriptRunEvent publish 到 'workflow' domain ──
  it('emit publishes every ScriptRunEvent to the workflow EventBus domain for the renderer', async () => {
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const event = { runId: 'wf-x', type: 'agent:start' as const, ts: 123, data: { agentId: 'a1', label: 'find' } };
    deps.emit?.(event);
    await vi.waitFor(() => expect(publishMock.mock.calls.some((c) => c[0] === 'workflow' && c[1] === 'agent:start')).toBe(true));
    const wfCall = publishMock.mock.calls.find((c) => c[0] === 'workflow' && c[1] === 'agent:start');
    expect(wfCall).toBeDefined();
    expect(wfCall![1]).toBe('agent:start'); // BusEvent.type = ScriptRunEvent.type
    // BusEvent.data = 完整 ScriptRunEvent + stamp 的 sessionId（会话隔离，Codex R1 HIGH#1）。
    const workflowRunId = (startRunMock.mock.calls[0][0] as ScriptRunSpec).runId;
    expect(wfCall![2]).toEqual({ ...event, runId: workflowRunId, sessionId: 'sess' });
  });

  it('emit forwards non-progress events (agent:done/run:done) to the bus too', async () => {
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    deps.emit?.({ runId: 'wf-x', type: 'run:done', ts: 1, data: { result: 1 } });
    const doneCall = publishMock.mock.calls.find((c) => c[0] === 'workflow' && c[1] === 'run:done');
    expect(doneCall).toBeDefined(); // run:done 不映射 onProgress，但必须进事件通道（否则进度树永远收不到收尾）
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
  it('derived subagent context does not carry parent currentToolCallId', async () => {
    const ctx = makeCtx({ currentToolCallId: 'parent-call-1' });
    await run({ script: 'return 1' }, ctx);
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const sub = deps.deriveSubagentContext({ agentId: 'a1', modelConfig: { ...BASE_MODEL }, signal: new AbortController().signal, capabilities: ORCHESTRATION_CAPABILITIES });
    expect(sub.currentToolCallId).toBeUndefined();
  });

  // R3 MED: child abortSignal 必须 = 入参 signal。
  it('derived subagent abortSignal equals the per-call signal, not parent', async () => {
    const parentCtrl = new AbortController();
    const childCtrl = new AbortController();
    await run({ script: 'return 1' }, makeCtx({ abortSignal: parentCtrl.signal }));
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const sub = deps.deriveSubagentContext({ agentId: 'a1', modelConfig: { ...BASE_MODEL }, signal: childCtrl.signal, capabilities: ORCHESTRATION_CAPABILITIES });
    expect(sub.abortSignal).toBe(childCtrl.signal);
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

  // ── Round 4 ──────────────────────────────────────────────────────────────

  // R4 LOW: 非 JSON-safe 结果（BigInt/循环引用）不得把已 completed 的 run 翻成 DOMAIN_ERROR
  it('does not fail a completed run when result is not JSON-serializable', async () => {
    startRunMock.mockResolvedValue(completedState({ result: { big: 10n } }));
    const r = await run({ script: 'return {big:10n}' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.output).toBe('string');
  });

  // R4 MED(defensive): override 缺 provider（类型上不该发生，但运行时防御）—— 同 base provider 下仍继承凭证
  it('resolveModelConfig falls back to base provider when override omits provider', async () => {
    resolveSessionDefaultMock.mockReturnValue({ provider: 'xiaomi', model: 'mimo-lite', apiKey: '', baseUrl: undefined });
    await run({ script: 'return 1' });
    const deps = startRunMock.mock.calls[0][1] as ScriptRunHostDeps;
    const resolved = deps.resolveModelConfig({ model: 'mimo-lite' } as never);
    expect(resolved.apiKey).toBe('base-key');
  });
});
