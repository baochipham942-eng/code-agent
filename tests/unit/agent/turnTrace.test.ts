import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

// G20 regression cover: TurnTraceRecorder accumulates structured turn events
// and flushes them incrementally to a per-session JSONL file.

const traceRoot = path.join(os.tmpdir(), `turntrace-test-${Date.now()}`);

vi.mock('../../../src/host/platform/appPaths', () => ({
  getPath: () => traceRoot,
}));

import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';

describe('TurnTraceRecorder', () => {
  afterEach(() => {
    if (existsSync(traceRoot)) rmSync(traceRoot, { recursive: true, force: true });
  });

  it('records events tagged with the current turn index', () => {
    const r = new TurnTraceRecorder('sess-1');
    r.setTurn(1);
    r.record('inference', { responseType: 'tool_use' });
    r.setTurn(2);
    r.record('loop_decision', { action: 'continue' });

    const events = r.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sessionId: 'sess-1', turnIndex: 1, type: 'inference' });
    expect(events[1]).toMatchObject({ turnIndex: 2, type: 'loop_decision' });
    expect(typeof events[0].ts).toBe('number');
  });

  it('flushes to a per-session JSONL file incrementally', () => {
    const r = new TurnTraceRecorder('sess-2');
    r.setTurn(1);
    r.record('inference', { a: 1 });
    r.flush();

    const file = path.join(traceRoot, 'traces', 'sess-2.jsonl');
    expect(existsSync(file)).toBe(true);
    let lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'inference', turnIndex: 1 });

    // second flush appends only the new event
    r.record('tool_dispatch', { toolName: 'bash' });
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
