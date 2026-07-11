// ============================================================================
// runService resumable 重放集成测试（P4-C）
//
// 用【真 worker_threads 沙箱】跑脚本（不 mock sandbox），但 mock 主线程的 inference——
// worker 只 marshal agent() 调用，真正的 agent 执行落在主线程 handleRpc→runAgentCall，故主线程
// mock 对真 worker 生效。配一个内存假 journal 验证：
//   - 首跑全 live；同脚本同 args resume → 全命中（0 inference / 0 token）
//   - 改某个 call 的 prompt → 仅该 call（及依赖它的下游）重跑，其余命中
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const inferenceMock = vi.fn();
vi.mock('../../../../src/host/model/adapters/aiSdkAdapter', () => ({
  inferenceViaAiSdk: (...a: unknown[]) => inferenceMock(...a),
}));

import { startRun, type ScriptRunHostDeps, type ScriptRunJournal } from '../../../../src/host/agent/scriptRuntime';

const baseModel = { provider: 'xiaomi', model: 'm', apiKey: 'k' };

/** 内存假 journal：run 写入的 calls 在另一 run resume 时回放（按 runId 分桶）。 */
function makeInMemoryJournal() {
  const runs = new Map<string, {
    scriptHash: string;
    goal?: string | null;
    inputHash?: string | null;
    calls: Map<number, { contentHash: string; result: string | Record<string, unknown> }>;
  }>();
  const journal: ScriptRunJournal = {
    loadPriorRun: (rid) => {
      const run = runs.get(rid);
      return run
        ? {
            run: { runId: rid, scriptHash: run.scriptHash, goal: run.goal ?? null, inputHash: run.inputHash ?? null },
            calls: run.calls,
          }
        : null;
    },
    loadPriorCalls: (rid) => runs.get(rid)?.calls ?? null,
    onRunStart: ({ runId, scriptHash, goal, inputHash }) => {
      if (!runs.has(runId)) {
        runs.set(runId, { scriptHash, goal: goal ?? null, inputHash, calls: new Map() });
      }
    },
    onRunFinish: () => {},
    onCallComplete: ({ runId, callIndex, contentHash, result }) => {
      const run = runs.get(runId) ?? {
        scriptHash: 'unknown',
        goal: null,
        inputHash: null,
        calls: new Map<number, { contentHash: string; result: string | Record<string, unknown> }>(),
      };
      run.calls.set(callIndex, { contentHash, result });
      runs.set(runId, run);
    },
  };
  return { journal, runs };
}

function makeDeps(journal: ScriptRunJournal): ScriptRunHostDeps {
  return {
    baseModelConfig: baseModel as never,
    resolveModelConfig: () => baseModel as never,
    deriveSubagentContext: () => ({}) as never,
    resolveAgentTools: () => ({ tools: [], writeCapable: false }),
    useOsSandbox: false,
    journal,
  };
}

const SCHEMA = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
const SCRIPT = `
  const a = await agent('q1', { schema: ${JSON.stringify(SCHEMA)} });
  const b = await agent('q2', { schema: ${JSON.stringify(SCHEMA)} });
  return { a, b };
`;

function forced(n: number, outputTokens: number) {
  return { toolCalls: [{ name: 'structured_output', arguments: { n } }], usage: { outputTokens } };
}

beforeEach(() => inferenceMock.mockReset());

describe('runService resumable 重放（真 worker）', () => {
  it('first run executes live; resume with unchanged script hits cache for all calls (0 inference / 0 tokens)', async () => {
    const { journal } = makeInMemoryJournal();
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));

    const r1 = await startRun(
      { runId: 'run-1', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps(journal),
    );
    expect(r1.status).toBe('completed');
    expect(r1.result).toEqual({ a: { n: 1 }, b: { n: 2 } });
    expect(r1.tokensSpent).toBe(30);
    expect(inferenceMock).toHaveBeenCalledTimes(2);

    inferenceMock.mockReset();
    const r2 = await startRun(
      { runId: 'run-2', script: SCRIPT, resumeFromRunId: 'run-1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps(journal),
    );
    expect(r2.status).toBe('completed');
    expect(r2.result).toEqual({ a: { n: 1 }, b: { n: 2 } }); // 命中旧结果
    expect(inferenceMock).not.toHaveBeenCalled(); // 全缓存命中
    expect(r2.tokensSpent).toBe(0); // 缓存命中 0 token
  });

  it('resume re-runs only the edited call and leaves earlier cached calls intact', async () => {
    const { journal } = makeInMemoryJournal();
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    await startRun({ runId: 'run-1', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' }, makeDeps(journal));

    // 改第二个 call 的 prompt → 它 miss 重跑；第一个 prompt 不变 → 命中。
    const edited = SCRIPT.replace("'q2'", "'q2-edited'");
    inferenceMock.mockReset();
    inferenceMock.mockResolvedValueOnce(forced(99, 7));
    const r2 = await startRun(
      { runId: 'run-2', script: edited, resumeFromRunId: 'run-1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps(journal),
    );
    expect(r2.status).toBe('completed');
    expect(r2.result).toEqual({ a: { n: 1 }, b: { n: 99 } }); // a 命中旧值，b 重跑新值
    expect(inferenceMock).toHaveBeenCalledTimes(1); // 只重跑 b
    expect(r2.tokensSpent).toBe(7);
  });

  it('resume misses all calls and warns when the goal/args context changes', async () => {
    const { journal } = makeInMemoryJournal();
    const logs: string[] = [];
    const deps = makeDeps(journal);
    deps.emit = (e) => { if (e.type === 'run:log' && typeof e.data?.message === 'string') logs.push(e.data.message); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    await startRun(
      { runId: 'run-1', script: SCRIPT, goal: 'alpha', defaultProvider: 'xiaomi', defaultModel: 'm' },
      deps,
    );

    inferenceMock.mockReset();
    inferenceMock.mockResolvedValueOnce(forced(10, 3)).mockResolvedValueOnce(forced(20, 4));
    const r2 = await startRun(
      { runId: 'run-2', script: SCRIPT, goal: 'beta', resumeFromRunId: 'run-1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      deps,
    );

    expect(r2.result).toEqual({ a: { n: 10 }, b: { n: 20 } });
    expect(r2.cacheHits).toBe(0);
    expect(r2.tokensSpent).toBe(7);
    expect(inferenceMock).toHaveBeenCalledTimes(2);
    expect(logs.some((message) => /goal\/args|上下文.*不同|全量 live/.test(message))).toBe(true);
  });

  it('resumed run journal is self-contained (chained resume re-hits both calls)', async () => {
    const { journal } = makeInMemoryJournal();
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    await startRun({ runId: 'run-1', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' }, makeDeps(journal));

    inferenceMock.mockReset();
    await startRun({ runId: 'run-2', script: SCRIPT, resumeFromRunId: 'run-1', defaultProvider: 'xiaomi', defaultModel: 'm' }, makeDeps(journal));

    // 从 run-2 再 resume → run-2 的 journal 应已自包含两条缓存（命中拷贝），全命中。
    inferenceMock.mockReset();
    const r3 = await startRun({ runId: 'run-3', script: SCRIPT, resumeFromRunId: 'run-2', defaultProvider: 'xiaomi', defaultModel: 'm' }, makeDeps(journal));
    expect(r3.result).toEqual({ a: { n: 1 }, b: { n: 2 } });
    expect(inferenceMock).not.toHaveBeenCalled();
  });

  // ── Codex round1 HIGH#3：journal 必须真 best-effort——SQLite/网关异常不得反噬执行 ──
  it('onCallComplete throwing does NOT fail an otherwise successful run (best-effort)', async () => {
    const { journal } = makeInMemoryJournal();
    journal.onCallComplete = () => { throw new Error('DB locked'); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    const r = await startRun({ runId: 'run-x', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' }, makeDeps(journal));
    expect(r.status).toBe('completed'); // 写库失败不该把成功 run 打成失败
    expect(r.result).toEqual({ a: { n: 1 }, b: { n: 2 } });
  });

  it('loadPriorCalls throwing degrades to a full live run (no crash)', async () => {
    const { journal } = makeInMemoryJournal();
    journal.loadPriorCalls = () => { throw new Error('DB read error'); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    const r = await startRun(
      { runId: 'run-y', script: SCRIPT, resumeFromRunId: 'whatever', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps(journal),
    );
    expect(r.status).toBe('completed');
    expect(inferenceMock).toHaveBeenCalledTimes(2); // 退化成全 live
  });

  it('onRunFinish runs even when a terminal emit throws (status never stuck running)', async () => {
    const { journal } = makeInMemoryJournal();
    const finishes: string[] = [];
    journal.onRunFinish = ({ status }) => finishes.push(status);
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    // deps.emit 在 run:done 终态事件上抛错
    const deps = makeDeps(journal);
    deps.emit = (e) => { if (e.type === 'run:done') throw new Error('emit boom'); };
    await startRun({ runId: 'run-z', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' }, deps).catch(() => {});
    expect(finishes).toContain('completed'); // onRunFinish 仍落库（在 finally）
  });

  // ── Codex round1 MED#3：resumeFromRunId 指向不存在的 run → 不静默，发 run:log 警告 ──
  it('warns (run:log) when resume is requested but the prior run has no journal', async () => {
    const { journal } = makeInMemoryJournal();
    const logs: string[] = [];
    const deps = makeDeps(journal);
    deps.emit = (e) => { if (e.type === 'run:log' && typeof e.data?.message === 'string') logs.push(e.data.message); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    await startRun(
      { runId: 'run-w', script: SCRIPT, resumeFromRunId: 'nonexistent', defaultProvider: 'xiaomi', defaultModel: 'm' },
      deps,
    );
    expect(logs.some((m) => /resume|重放|无.*journal|未找到/i.test(m))).toBe(true);
  });

  // ── Codex round2 MED#3：警告 emit 本身必须 best-effort，不能在执行前把 run 中断 ──
  it('a throwing resume-miss warning emit does NOT abort the run (best-effort observability)', async () => {
    const { journal } = makeInMemoryJournal();
    const deps = makeDeps(journal);
    // host emit 在 run:log（即警告）上抛错；run:start/done 等放行
    deps.emit = (e) => { if (e.type === 'run:log') throw new Error('emit boom'); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    const r = await startRun(
      { runId: 'run-warn-throw', script: SCRIPT, resumeFromRunId: 'nonexistent', defaultProvider: 'xiaomi', defaultModel: 'm' },
      deps,
    );
    expect(r.status).toBe('completed'); // 警告 emit 抛错被吞，run 照常完成
  });

  // ── Codex round3 MED：terminal emit（run:done/run:error）是观测层，抛错不得顶替权威结果 ──
  it('a throwing run:done emit does NOT reject a successfully completed run', async () => {
    const { journal } = makeInMemoryJournal();
    const deps = makeDeps(journal);
    deps.emit = (e) => { if (e.type === 'run:done') throw new Error('emit boom on done'); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    const r = await startRun({ runId: 'run-done-throw', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' }, deps);
    expect(r.status).toBe('completed'); // 观测 emit 抛错被吞，权威结果照常返回
    expect(r.result).toEqual({ a: { n: 1 }, b: { n: 2 } });
  });

  it('a throwing run:error emit does NOT mask the real script error', async () => {
    const { journal } = makeInMemoryJournal();
    const deps = makeDeps(journal);
    deps.emit = (e) => { if (e.type === 'run:error') throw new Error('emit boom on error'); };
    const r = await startRun(
      { runId: 'run-err-throw', script: "throw new Error('script boom');", defaultProvider: 'xiaomi', defaultModel: 'm' },
      deps,
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/script boom/); // 调用方拿到脚本真错，不是 emit 错
  });

  // ── Codex round2 MED#3：执行前 emit 抛错时，journal 终态不得被写成 'running'（规整成终态）──
  it('onRunFinish never records a stuck "running" status when a pre-execution emit throws', async () => {
    const { journal } = makeInMemoryJournal();
    const finishes: string[] = [];
    journal.onRunFinish = ({ status }) => finishes.push(status);
    const deps = makeDeps(journal);
    deps.emit = (e) => { if (e.type === 'run:start') throw new Error('emit boom on start'); };
    inferenceMock.mockResolvedValueOnce(forced(1, 10)).mockResolvedValueOnce(forced(2, 20));
    await startRun({ runId: 'run-stuck', script: SCRIPT, defaultProvider: 'xiaomi', defaultModel: 'm' }, deps).catch(() => {});
    // finally 必然调 onRunFinish；状态须是终态而非残留的 'running'
    expect(finishes.length).toBeGreaterThan(0);
    expect(finishes.every((s) => s !== 'running')).toBe(true);
  });
});
