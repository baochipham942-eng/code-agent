// ============================================================================
// runService Tests — activeRuns 异常安全（Codex audit R2 HIGH）
//
// startRun 体内若抛（deps.emit / worker / abort 以 rejected promise 冒出），
// activeRuns 必须仍被清理，否则 stale run 泄漏 + 后续 cancel/状态串线。
// ============================================================================

import { beforeEach, describe, it, expect, vi } from 'vitest';

const processSandboxHarness = vi.hoisted(() => ({
  spawned: [] as import('node:child_process').ChildProcessWithoutNullStreams[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      // processSandbox 用固定的 stdio: 'pipe' 调 spawn，实际总是拿到非空
      // stdin/stdout/stderr（即 ChildProcessWithoutNullStreams 形状）；
      // 但按 Parameters<typeof actual.spawn> 泛型转发参数时 TS 解析到的重载
      // 只给出泛化的 ChildProcess，这里按已知运行时形状断言。
      processSandboxHarness.spawned.push(child as import('node:child_process').ChildProcessWithoutNullStreams);
      return child;
    },
  };
});

// worker 用 mock 隔离（不真起 worker_threads）
vi.mock('../../../../src/host/agent/scriptRuntime/sandbox', () => ({
  runScriptInSandbox: vi.fn(async () => ({ ok: true, result: 'ok' })),
}));

import { runScriptInSandbox } from '../../../../src/host/agent/scriptRuntime/sandbox';
import { startRun, cancelRun, getRunState, type ScriptRunHostDeps } from '../../../../src/host/agent/scriptRuntime';
import type { RpcResponse } from '../../../../src/host/agent/scriptRuntime/types';

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

  it('aborts in-flight RPC synchronously on sandbox timeout while preserving timeout classification', async () => {
    const timeoutError = 'process sandbox 执行超时 50ms';
    let signalAbortedWhenTimeoutHandled = false;
    vi.mocked(runScriptInSandbox).mockImplementationOnce(async (opts) => {
      const onTimeout = (opts as typeof opts & { onTimeout?: () => void }).onTimeout;
      onTimeout?.();
      signalAbortedWhenTimeoutHandled = opts.signal.aborted;
      return { ok: false, error: timeoutError };
    });

    const state = await startRun(
      { runId: 'wf-timeout-abort', script: 'return agent("slow")', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps(),
    );

    expect(signalAbortedWhenTimeoutHandled).toBe(true);
    expect(state).toMatchObject({ status: 'failed', error: timeoutError });
    expect(getRunState('wf-timeout-abort')).toBeUndefined();
  });

  it.each(['resolve', 'reject'] as const)(
    'does not write a late %s RPC response after the real sandbox child is dead',
    async (settlement) => {
      const { runScriptInSandbox: runActualSandbox } = await vi.importActual<
        typeof import('../../../../src/host/agent/scriptRuntime/sandbox')
      >('../../../../src/host/agent/scriptRuntime/sandbox');
      let resolveRpc!: (response: RpcResponse) => void;
      let rejectRpc!: (error: Error) => void;
      let rpcStarted!: () => void;
      const started = new Promise<void>((resolve) => { rpcStarted = resolve; });
      const rpc = new Promise<RpcResponse>((resolve, reject) => {
        resolveRpc = resolve;
        rejectRpc = reject;
      });
      const spawnIndex = processSandboxHarness.spawned.length;

      const running = runActualSandbox({
        script: 'return agent("late host response")',
        signal: new AbortController().signal,
        useOsSandbox: false,
        timeoutMs: 5_000,
        onRpc: async () => {
          rpcStarted();
          return rpc;
        },
      });

      await started;
      const child = processSandboxHarness.spawned[spawnIndex];
      expect(child).toBeDefined();
      const writeSpy = vi.spyOn(child.stdin, 'write');
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      process.kill(child.pid!, 'SIGKILL');
      await closed;
      expect(child.stdin.destroyed).toBe(true);
      writeSpy.mockClear();

      if (settlement === 'resolve') {
        expect(() => resolveRpc({ id: 1, ok: true, result: 'late' })).not.toThrow();
      } else {
        expect(() => rejectRpc(new Error('late failure'))).not.toThrow();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(writeSpy).not.toHaveBeenCalled();
      expect(() => child.stdin.emit('error', new Error('late stdin error'))).not.toThrow();
      await expect(running).resolves.toMatchObject({ ok: false });
      writeSpy.mockRestore();
    },
  );

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

// N-PTCEXEC：PTC 通道从 host deps 到 sandbox/ctx 的接线。
// 执行方与名单是一对——半开状态（有名单没执行方 / 有执行方没名单）会让脚本拿到
// 一份调什么都失败的命名空间，比彻底关闭更难排查，所以一律按关闭处理。
describe('runService · PTC 通道接线', () => {
  const toolNamesOf = () => (vi.mocked(runScriptInSandbox).mock.calls[0][0] as { toolNames?: string[] }).toolNames;

  it('执行方 + 名单齐全 → 名单下发给 child，RPC 能落到执行方', async () => {
    const executeTool = vi.fn(async () => ({ ok: true as const, value: 'r' }));
    let onRpc: ((req: unknown) => Promise<RpcResponse>) | undefined;
    vi.mocked(runScriptInSandbox).mockImplementationOnce(async (opts) => {
      onRpc = (opts as unknown as { onRpc: (req: unknown) => Promise<RpcResponse> }).onRpc;
      return { ok: true, result: 'ok' };
    });

    await startRun(
      { runId: 'wf-ptc-on', script: 'return 1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps({ executeTool, visibleToolNames: ['Read'] }),
    );

    expect(toolNamesOf()).toEqual(['Read']);
    await expect(onRpc!({ id: 1, kind: 'tool', payload: { name: 'Read', args: {} } }))
      .resolves.toMatchObject({ ok: true, result: 'r' });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('只有执行方没有名单 → 通道整条关闭', async () => {
    await startRun(
      { runId: 'wf-ptc-halfa', script: 'return 1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps({ executeTool: vi.fn(), visibleToolNames: [] }),
    );
    expect(toolNamesOf()).toEqual([]);
  });

  it('只有名单没有执行方 → 名单也不下发，child 侧调什么都是 UNKNOWN_TOOL', async () => {
    let onRpc: ((req: unknown) => Promise<RpcResponse>) | undefined;
    vi.mocked(runScriptInSandbox).mockImplementationOnce(async (opts) => {
      onRpc = (opts as unknown as { onRpc: (req: unknown) => Promise<RpcResponse> }).onRpc;
      return { ok: true, result: 'ok' };
    });

    await startRun(
      { runId: 'wf-ptc-halfb', script: 'return 1', defaultProvider: 'xiaomi', defaultModel: 'm' },
      makeDeps({ visibleToolNames: ['Read'] }),
    );

    expect(toolNamesOf()).toEqual([]);
    await expect(onRpc!({ id: 1, kind: 'tool', payload: { name: 'Read', args: {} } }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('UNKNOWN_TOOL') });
  });
});
