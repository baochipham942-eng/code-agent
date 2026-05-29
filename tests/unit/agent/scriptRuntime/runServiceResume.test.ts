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
vi.mock('../../../../src/main/model/adapters/aiSdkAdapter', () => ({
  inferenceViaAiSdk: (...a: unknown[]) => inferenceMock(...a),
}));

import { startRun, type ScriptRunHostDeps, type ScriptRunJournal } from '../../../../src/main/agent/scriptRuntime';

const baseModel = { provider: 'xiaomi', model: 'm', apiKey: 'k' };

/** 内存假 journal：run 写入的 calls 在另一 run resume 时回放（按 runId 分桶）。 */
function makeInMemoryJournal() {
  const runs = new Map<string, Map<number, { contentHash: string; result: string | Record<string, unknown> }>>();
  const journal: ScriptRunJournal = {
    loadPriorCalls: (rid) => runs.get(rid) ?? null,
    onRunStart: ({ runId }) => {
      if (!runs.has(runId)) runs.set(runId, new Map());
    },
    onRunFinish: () => {},
    onCallComplete: ({ runId, callIndex, contentHash, result }) => {
      const m = runs.get(runId) ?? new Map();
      m.set(callIndex, { contentHash, result });
      runs.set(runId, m);
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
});
