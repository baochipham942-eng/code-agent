// ============================================================================
// runService Tests — activeRuns 异常安全（Codex audit R2 HIGH）
//
// startRun 体内若抛（deps.emit / worker / abort 以 rejected promise 冒出），
// activeRuns 必须仍被清理，否则 stale run 泄漏 + 后续 cancel/状态串线。
// ============================================================================

import { beforeEach, describe, it, expect, vi } from 'vitest';

// worker 用 mock 隔离（不真起 worker_threads）
vi.mock('../../../../src/host/agent/scriptRuntime/sandbox', () => ({
  runScriptInSandbox: vi.fn(async () => ({ ok: true, result: 'ok' })),
}));

import { runScriptInSandbox } from '../../../../src/host/agent/scriptRuntime/sandbox';
import { startRun, cancelRun, getRunState, type ScriptRunHostDeps } from '../../../../src/host/agent/scriptRuntime';

const baseModel = { provider: 'xiaomi', model: 'm', apiKey: 'k' };

beforeEach(() => {
  vi.mocked(runScriptInSandbox).mockReset();
  vi.mocked(runScriptInSandbox).mockResolvedValue({ ok: true, result: 'ok' });
});

function makeDeps(over: Partial<ScriptRunHostDeps> = {}): ScriptRunHostDeps {
  return {
    baseModelConfig: baseModel as never,
    resolveModelConfig: () => baseModel as never,
    deriveSubagentContext: () => ({}) as never,
    resolveAgentTools: () => ({ tools: [], writeCapable: false }),
    useOsSandbox: false,
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

  it('emits run:cancelled and returns cancelled state when cancelRun aborts the workflow', async () => {
    const runId = 'wf-canceltest-1';
    const events: string[] = [];
    vi.mocked(runScriptInSandbox).mockImplementationOnce((opts) => new Promise((resolve) => {
      opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'run aborted' }), { once: true });
    }));

    const run = startRun(
      { runId, sessionId: 'sess-A', script: 'await new Promise(() => {})', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps({ emit: (event) => events.push(event.type) }),
    );

    expect(getRunState(runId)?.sessionId).toBe('sess-A');
    expect(cancelRun(runId, { sessionId: 'sess-B' })).toBe(false);
    expect(cancelRun(runId, { sessionId: 'sess-A' })).toBe(true);

    await expect(run).resolves.toMatchObject({ status: 'cancelled', error: 'run aborted' });
    expect(events).toContain('run:cancelled');
    expect(events).not.toContain('run:error');
    expect(getRunState(runId)).toBeUndefined();
  });

  it('redacts credentials before final checkpoint persistence', async () => {
    const journal = {
      loadPriorCalls: vi.fn(() => null),
      onRunStart: vi.fn(),
      onRunFinish: vi.fn(),
      onCallComplete: vi.fn(),
    };
    vi.mocked(runScriptInSandbox).mockResolvedValueOnce({
      ok: true,
      result: { apiKey: 'sk-super-secret-value', text: 'Bearer abcdefghijklmnop' },
    });
    const state = await startRun(
      { runId: 'wf-redact', script: 'return 1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps({ journal }),
    );
    expect(JSON.stringify(state.result)).not.toContain('super-secret-value');
    expect(JSON.stringify(journal.onRunFinish.mock.calls)).not.toContain('super-secret-value');
  });
});
