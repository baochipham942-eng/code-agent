import { describe, expect, it, vi } from 'vitest';
import { runScriptInSandbox } from '../../../../src/host/agent/scriptRuntime/sandbox';
import {
  createRunTraceContext,
  getActiveRunTraceContext,
  serializeRunTraceContext,
} from '../../../../src/host/telemetry/runTraceContext';
import { getTelemetryService } from '../../../../src/host/telemetry/telemetryService';

function run(script: string, signal = new AbortController().signal) {
  return runScriptInSandbox({
    script,
    signal,
    onRpc: async (req) => ({ id: req.id, ok: true, result: null }),
    timeoutMs: 5_000,
    useOsSandbox: false,
  });
}

describe('process-level orchestration sandbox', () => {
  it('contains globalThis/eval/constructor escape inside a credential-free child', async () => {
    const secret = `sk-sandbox-${Date.now()}-credential`;
    process.env.CODE_AGENT_SANDBOX_TEST_API_KEY = secret;
    try {
      const outcome = await run(`
        const escaped = ({}).constructor.constructor('return this')() ?? {};
        return {
          processType: typeof escaped.process,
          requireType: typeof escaped.require,
          envSecret: escaped.process?.env?.CODE_AGENT_SANDBOX_TEST_API_KEY,
          hostMarker: escaped.__CODE_AGENT_HOST_MARKER__,
        };
      `);
      expect(outcome).toEqual({
        ok: true,
        result: {
          processType: 'undefined',
          requireType: 'undefined',
          envSecret: undefined,
          hostMarker: undefined,
        },
      });
    } finally {
      delete process.env.CODE_AGENT_SANDBOX_TEST_API_KEY;
    }
  });

  it('cannot load fs, net, or child_process through constructor escape', async () => {
    const outcome = await run(`
      const get = ({}).constructor.constructor;
      const probe = (name) => {
        try { return typeof get('return require')()(name); }
        catch (error) { return 'denied'; }
      };
      return { fs: probe('fs'), net: probe('net'), child: probe('child_process') };
    `);
    expect(outcome).toEqual({
      ok: true,
      result: { fs: 'denied', net: 'denied', child: 'denied' },
    });
  });

  it('exposes only agent/phase/log across Host IPC', async () => {
    const kinds: string[] = [];
    const outcome = await runScriptInSandbox({
      script: `
        await phase('one');
        await log('safe');
        return await agent('task');
      `,
      signal: new AbortController().signal,
      useOsSandbox: false,
      timeoutMs: 5_000,
      onRpc: async (request) => {
        kinds.push(request.kind);
        return { id: request.id, ok: true, result: request.kind === 'agent' ? 'done' : null };
      },
    });
    expect(outcome).toEqual({ ok: true, result: 'done' });
    expect(kinds).toEqual(['phase', 'log', 'agent']);
  });

  it('terminates the complete process group on cancel', async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const running = runScriptInSandbox({
      script: 'await new Promise(() => {});',
      signal: controller.signal,
      onRpc: async (req) => ({ id: req.id, ok: true, result: null }),
      timeoutMs: 20_000,
      onProcessSpawn: (childPid) => { pid = childPid; },
      useOsSandbox: false,
    });
    await vi.waitFor(() => expect(pid).toBeTypeOf('number'));
    controller.abort();
    await expect(running).resolves.toMatchObject({ ok: false, error: 'run aborted' });
    await vi.waitFor(() => {
      expect(() => process.kill(pid!, 0)).toThrow();
    });
  });

  it('keeps the legacy worker path behind an explicit opt-in', async () => {
    const onProcessSpawn = vi.fn();
    const outcome = await runScriptInSandbox({
      script: 'return 7;',
      signal: new AbortController().signal,
      onRpc: async (request) => ({ id: request.id, ok: true, result: null }),
      timeoutMs: 5_000,
      legacyWorkerFallback: true,
      onProcessSpawn,
    });
    expect(outcome).toEqual({ ok: true, result: 7, error: undefined });
    expect(onProcessSpawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('restores target trace context for child RPC (legacy=%s)', async (legacyWorkerFallback) => {
    const parent = createRunTraceContext({
      runId: `workflow-run-${legacyWorkerFallback ? 'legacy' : 'process'}`,
      sessionId: 'session-workflow',
      attempt: 1,
      ownerEpoch: 1,
      engine: 'dynamic_workflow',
      workspace: '/tmp/workflow',
      processInstanceId: 'host-process',
    });
    const seen: Array<{ traceId?: string; spanId?: string; kind: string }> = [];
    const outcome = await runScriptInSandbox({
      script: `await phase('node'); return await agent('task');`,
      signal: new AbortController().signal,
      useOsSandbox: false,
      legacyWorkerFallback,
      traceContext: serializeRunTraceContext(parent),
      onRpc: async (request) => {
        const active = getActiveRunTraceContext();
        seen.push({ traceId: active?.traceId, spanId: active?.spanId, kind: request.kind });
        return { id: request.id, ok: true, result: request.kind === 'agent' ? 'done' : null };
      },
    });

    expect(outcome).toMatchObject({ ok: true, result: 'done' });
    expect(seen.map((entry) => entry.kind)).toEqual(['phase', 'agent']);
    expect(seen.every((entry) => entry.traceId === parent.traceId)).toBe(true);
    expect(new Set(seen.map((entry) => entry.spanId)).size).toBe(2);
    expect(seen.every((entry) => entry.spanId !== parent.spanId)).toBe(true);
    const rpcSpans = getTelemetryService().getRecentSpans(20)
      .filter((span) => span.traceId === parent.traceId && span.name.startsWith('workflow rpc:'));
    expect(rpcSpans).toHaveLength(2);
    expect(rpcSpans.every((span) => span.parentSpanId === parent.spanId)).toBe(true);
  });
});
