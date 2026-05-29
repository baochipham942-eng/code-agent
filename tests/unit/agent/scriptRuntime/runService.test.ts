// ============================================================================
// runService Tests — activeRuns 异常安全（Codex audit R2 HIGH）
//
// startRun 体内若抛（deps.emit / worker / abort 以 rejected promise 冒出），
// activeRuns 必须仍被清理，否则 stale run 泄漏 + 后续 cancel/状态串线。
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

// worker 用 mock 隔离（不真起 worker_threads）
vi.mock('../../../../src/main/agent/scriptRuntime/sandbox', () => ({
  runScriptInWorker: vi.fn(async () => ({ ok: true, result: 'ok' })),
}));

import { startRun, getRunState, type ScriptRunHostDeps } from '../../../../src/main/agent/scriptRuntime';

const baseModel = { provider: 'xiaomi', model: 'm', apiKey: 'k' };

function makeDeps(over: Partial<ScriptRunHostDeps> = {}): ScriptRunHostDeps {
  return {
    baseModelConfig: baseModel as never,
    resolveModelConfig: () => baseModel as never,
    deriveSubagentContext: () => ({}) as never,
    defaultAgentTools: [],
    ...over,
  };
}

describe('runService activeRuns 异常安全', () => {
  it('clears activeRuns when the run body throws (e.g. deps.emit throws on run:start)', async () => {
    const runId = 'wf-throwtest-1';
    const deps = makeDeps({
      emit: () => { throw new Error('emit boom'); },
    });
    await expect(startRun({ runId, script: 'return 1', defaultProvider: 'xiaomi', defaultModel: 'm' }, deps))
      .rejects.toThrow();
    // 关键断言：抛错后该 run 不得残留在 activeRuns
    expect(getRunState(runId)).toBeUndefined();
  });
});
