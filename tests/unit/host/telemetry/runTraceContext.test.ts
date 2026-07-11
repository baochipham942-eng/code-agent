import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  bindRunTraceContext,
  createChildRunTraceContext,
  createRunTraceContext,
  getActiveRunTraceContext,
  restoreRunTraceContext,
  serializeRunTraceContext,
  withRunTraceContext,
} from '../../../../src/host/telemetry/runTraceContext';

function create(runId: string, overrides: Record<string, unknown> = {}) {
  return createRunTraceContext({
    runId,
    sessionId: 'session-1',
    attempt: 1,
    ownerEpoch: 1,
    engine: 'native',
    workspace: '/tmp/workspace',
    processInstanceId: 'process-1',
    ...overrides,
  });
}

describe('RunTraceContext', () => {
  it('isolates concurrent Native runs and parallel child spans', async () => {
    const runA = create('run-a');
    const runB = create('run-b');

    const [seenA, seenB] = await Promise.all([
      withRunTraceContext(runA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const child = createChildRunTraceContext(getActiveRunTraceContext()!, { agentId: 'agent-a' });
        return [getActiveRunTraceContext(), child] as const;
      }),
      withRunTraceContext(runB, async () => {
        await Promise.resolve();
        const child = createChildRunTraceContext(getActiveRunTraceContext()!, { agentId: 'agent-b' });
        return [getActiveRunTraceContext(), child] as const;
      }),
    ]);

    expect(seenA[0]?.traceId).toBe(runA.traceId);
    expect(seenB[0]?.traceId).toBe(runB.traceId);
    expect(runA.traceId).not.toBe(runB.traceId);
    expect(runA.spanId).not.toBe(runB.spanId);
    expect(seenA[1].spanId).not.toBe(seenB[1].spanId);
    expect(seenA[1].traceId).toBe(runA.traceId);
  });

  it('gives sequential attempts in one session different spans and keeps a logical trace on recovery', () => {
    const firstRun = create('run-1');
    const secondRun = create('run-2');
    const recovered = create('run-1', {
      attempt: 2,
      ownerEpoch: 2,
      processInstanceId: 'process-2',
      traceId: firstRun.traceId,
    });

    expect(firstRun.traceId).not.toBe(secondRun.traceId);
    expect(firstRun.spanId).not.toBe(secondRun.spanId);
    expect(recovered.traceId).toBe(firstRun.traceId);
    expect(recovered.spanId).not.toBe(firstRun.spanId);
    expect(recovered.attempt).toBe(2);
  });

  it('propagates through Promise, timer, EventEmitter and an explicitly bound callback', async () => {
    const traceContext = create('run-async');
    const emitter = new EventEmitter();
    const observed: string[] = [];

    await withRunTraceContext(traceContext, async () => {
      emitter.once('event', () => observed.push(getActiveRunTraceContext()?.runId ?? 'missing'));
      const bound = bindRunTraceContext(traceContext, () => {
        observed.push(getActiveRunTraceContext()?.runId ?? 'missing');
      });
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(() => {
        observed.push(getActiveRunTraceContext()?.runId ?? 'missing');
        emitter.emit('event');
        resolve();
      }, 0));
      await Promise.resolve().then(bound);
    });

    expect(observed).toEqual(['run-async', 'run-async', 'run-async']);
    expect(getActiveRunTraceContext()).toBeUndefined();
  });

  it('serializes only the allowlisted W3C and run metadata fields', () => {
    const traceContext = create('run-safe', {
      traceState: 'vendor=value',
      agentId: 'agent-safe',
      parentRunId: 'run-parent',
    });
    const serialized = serializeRunTraceContext(traceContext);
    const restored = restoreRunTraceContext({
      ...serialized,
      authorization: 'Bearer secret',
      cookie: 'secret',
      apiKey: 'secret',
      prompt: 'secret prompt',
    });

    expect(restored).toEqual(traceContext);
    expect(JSON.stringify(serialized)).not.toMatch(/Bearer|cookie|apiKey|prompt/i);
    expect(serialized.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });
});
