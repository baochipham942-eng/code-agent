import { describe, expect, it, vi } from 'vitest';
import {
  createSubagentEventScope,
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
  return createSubagentEventScope({
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

  it('emits one start receipt and one terminal for N turns without parent turn boundaries', () => {
    const events: CapturedEvent[] = [];
    const lifecycle = makeLifecycle(events, 'agent-a', 'run-a', ['a-1', 'a-2', 'a-3']);

    const turnIds = [1, 2, 3].map((iteration) => {
      const turnId = lifecycle.startTurn(iteration);
      expect(lifecycle.endTurn(turnId)).toBe(true);
      return turnId;
    });
    lifecycle.endRun('completed');

    expect(turnIds).toEqual(['a-1', 'a-2', 'a-3']);
    expect(events.filter((event) => event.type === 'subagent_activity')).toEqual([{
      type: 'subagent_activity',
      data: {
        agentId: 'agent-a',
        runId: 'run-a',
        parentToolUseId: 'parent-agent-a',
        kind: 'started',
      },
    }]);
    expect(events.filter((event) => event.type === 'subagent_run_end')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_start')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(0);
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
    expect(events.filter((event) => event.type === 'subagent_activity')).toEqual([{
      type: 'subagent_activity',
      data: {
        agentId: `agent-${status}`,
        runId: `run-${status}`,
        parentToolUseId: `parent-agent-${status}`,
        kind: 'started',
      },
    }]);
    expect(events.filter((event) => event.type === 'turn_start')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(0);
  });
});
