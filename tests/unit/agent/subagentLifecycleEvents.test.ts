import { describe, expect, it, vi } from 'vitest';
import {
  createSubagentEventScope,
  createSubagentLifecycleEvents,
} from '../../../src/host/agent/subagentLifecycleEvents';

interface CapturedEvent {
  type: string;
  data: Record<string, unknown>;
}

function makeLifecycle(
  events: CapturedEvent[],
  agentId: string,
  runId: string,
  turnIds: string[],
) {
  return createSubagentLifecycleEvents({
    events: {
      emit: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
    },
    identity: { agentId, runId, parentToolUseId: `parent-${agentId}` },
    generateTurnId: vi.fn(() => turnIds.shift() as string),
  });
}

describe('subagent lifecycle events', () => {
  it('emits tool start/end with agent/run identity even without a parent tool id', () => {
    const events: CapturedEvent[] = [];
    const scope = createSubagentEventScope({
      events: {
        emit: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
      },
      identity: { agentId: 'agent-a', runId: 'run-a' },
    });

    scope.emitToolCallStart({ id: 'tool-a', name: 'Read', arguments: { path: 'README.md' } });
    scope.emitToolCallEnd('tool-a', { success: true, output: 'ok' }, 12);

    expect(events).toHaveLength(2);
    expect(events.every((event) => (
      event.data.agentId === 'agent-a'
      && event.data.runId === 'run-a'
      && event.data.parentToolUseId === undefined
    ))).toBe(true);
  });

  it('keeps interleaved concurrent turns paired within each agent/run slot', () => {
    const events: CapturedEvent[] = [];
    const first = makeLifecycle(events, 'agent-a', 'run-a', ['a-1', 'a-2']);
    const second = makeLifecycle(events, 'agent-b', 'run-b', ['b-1', 'b-2']);

    const a1 = first.startTurn(1);
    const b1 = second.startTurn(1);
    first.endTurn(a1);
    const a2 = first.startTurn(2);
    second.endTurn(b1);
    const b2 = second.startTurn(2);
    second.endTurn(b2);
    first.endTurn(a2);

    for (const [agentId, runId] of [['agent-a', 'run-a'], ['agent-b', 'run-b']]) {
      const slotEvents = events.filter((event) => (
        event.data.agentId === agentId && event.data.runId === runId
      ));
      const starts = slotEvents.filter((event) => event.type === 'turn_start');
      const ends = slotEvents.filter((event) => event.type === 'turn_end');
      expect(starts).toHaveLength(2);
      expect(ends).toHaveLength(2);
      expect(ends.map((event) => event.data.turnId).sort()).toEqual(
        starts.map((event) => event.data.turnId).sort(),
      );
      expect(slotEvents.every((event) => (
        event.data.parentToolUseId === `parent-${agentId}`
      ))).toBe(true);
    }
  });

  it.each([
    ['completed', undefined],
    ['cancelled', 'Cancelled by parent'],
    ['failed', 'Provider failed'],
  ] as const)('emits exactly one %s run terminal without parent-session terminal events', (status, error) => {
    const events: CapturedEvent[] = [];
    const lifecycle = makeLifecycle(events, `agent-${status}`, `run-${status}`, [`turn-${status}`]);
    lifecycle.startTurn(1);

    expect(lifecycle.endRun(status, error)).toBe(true);
    expect(lifecycle.endRun(status, error)).toBe(false);

    const terminals = events.filter((event) => event.type === 'subagent_run_end');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.data).toEqual({
      agentId: `agent-${status}`,
      runId: `run-${status}`,
      parentToolUseId: `parent-agent-${status}`,
      status,
      ...(error ? { error } : {}),
    });
    expect(events.filter((event) => (
      event.type === 'agent_complete' || event.type === 'agent_cancelled'
    ))).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(1);
  });
});
