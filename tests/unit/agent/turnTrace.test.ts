import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

const fsMocks = vi.hoisted(() => ({ appendFileSync: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  fsMocks.appendFileSync.mockImplementation(actual.appendFileSync);
  return { ...actual, appendFileSync: fsMocks.appendFileSync };
});

// G20 regression cover: TurnTraceRecorder accumulates structured turn events
// and flushes them incrementally to a per-session JSONL file.

const traceRoot = path.join(os.tmpdir(), `turntrace-test-${Date.now()}`);

vi.mock('../../../src/host/platform/appPaths', () => ({
  getPath: () => traceRoot,
}));

import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import type { TraceEventDataMap } from '../../../src/host/agent/runtime/turnTrace';

const manifestData = {
  requestId: 'llm-1',
  messageRefs: [{ kind: 'system_prompt', contentHash: 'a'.repeat(64) }],
  toolSchemaHash: 'b'.repeat(64),
  toolNames: ['Read'],
  requested: {
    provider: 'openai', model: 'gpt-5.5', temperature: null, maxTokens: 8192,
    reasoningEffort: 'high', thinkingBudget: null,
  },
  actualProvider: null,
  actualModel: null,
  appVersion: '0.32.0',
  adapterDefaults: { engine: 'aisdk', temperature: null, maxTokens: null },
  compactionReplacements: [],
  degraded: false,
} satisfies TraceEventDataMap['request_manifest'];

describe('TurnTraceRecorder', () => {
  afterEach(() => {
    fsMocks.appendFileSync.mockClear();
    if (existsSync(traceRoot)) rmSync(traceRoot, { recursive: true, force: true });
  });

  it('marks a manifest degraded without throwing when flush fails', () => {
    const r = new TurnTraceRecorder('sess-degraded');
    r.record('request_manifest', { ...manifestData, degraded: false });
    fsMocks.appendFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(r.flush()).toBe(false);
    const event = r.getEvents()[0];
    expect(event.type).toBe('request_manifest');
    if (event.type === 'request_manifest') expect(event.data.degraded).toBe(true);
  });

  it('records events tagged with the current turn index', () => {
    const r = new TurnTraceRecorder('sess-1');
    r.setTurn(1);
    r.record('inference', {
      responseType: 'tool_use',
      durationMs: 12,
      inputTokens: 10,
      outputTokens: 2,
      finishReason: 'tool_calls',
      truncated: false,
    });
    r.setTurn(2);
    r.record('loop_decision', {
      action: 'continue',
      execution: 'advisory',
      reason: 'tool call pending',
      stopReason: 'tool_calls',
      consecutiveErrors: 0,
      contextRatio: 0.1,
    });

    const events = r.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sessionId: 'sess-1', turnIndex: 1, type: 'inference' });
    expect(events[1]).toMatchObject({ turnIndex: 2, type: 'loop_decision' });
    expect(typeof events[0].ts).toBe('number');
  });

  it('records a fully shaped request manifest', () => {
    const r = new TurnTraceRecorder('sess-manifest');
    r.setTurn(3);
    r.record('request_manifest', manifestData);
    expect(r.getEvents()[0]).toMatchObject({
      type: 'request_manifest',
      turnIndex: 3,
      data: { requestId: 'llm-1', degraded: false },
    });

    if (false) {
      // @ts-expect-error request_manifest 缺 required 字段必须被测试侧 typecheck 拦住
      r.record('request_manifest', { requestId: 'incomplete' });
    }
  });

  it('flushes to a per-session JSONL file incrementally', () => {
    const r = new TurnTraceRecorder('sess-2');
    r.setTurn(1);
    r.record('inference', {
      responseType: 'text',
      durationMs: 5,
      inputTokens: 3,
      outputTokens: 1,
      finishReason: 'stop',
      truncated: false,
    });
    r.flush();

    const file = path.join(traceRoot, 'traces', 'sess-2.jsonl');
    expect(existsSync(file)).toBe(true);
    let lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'inference', turnIndex: 1 });

    // second flush appends only the new event
    r.record('tool_dispatch', {
      toolName: 'bash',
      success: true,
      durationMs: 2,
      error: null,
      fromCache: false,
    });
    r.flush();
    lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'tool_dispatch' });

    // flush with nothing new is a no-op
    r.flush();
    lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
