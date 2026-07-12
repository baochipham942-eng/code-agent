import { describe, expect, it, vi } from 'vitest';
import {
  GraphEventCompatibilityAdapter,
  projectGraphEvent,
  type GraphEvent,
} from '../../../src/host/orchestration';

function event(type: GraphEvent['type'], extra: Partial<GraphEvent> = {}): GraphEvent {
  return {
    type,
    graphId: 'graph-1',
    runId: 'run-1',
    sessionId: 'session-1',
    attempt: 2,
    sequence: 3,
    timestamp: 100,
    trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
    ...extra,
  };
}

describe('GraphEvent compatibility adapter', () => {
  it('preserves run/session/attempt/trace in replay evidence and public projections', () => {
    const projected = projectGraphEvent(event('node_started', { nodeId: 'node-1', nodeStatus: 'running' }));
    expect(projected.swarm[0]).toMatchObject({ runId: 'run-1', sessionId: 'session-1', treeId: 'graph-1' });
    expect(projected.script[0]).toMatchObject({ runId: 'run-1', sessionId: 'session-1' });
    expect(projected.session[0]).toMatchObject({
      sessionId: 'session-1',
      data: { runId: 'run-1', attempt: 2, trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) } },
    });
  });

  it('projects only one public terminal per Graph attempt', async () => {
    const agent = vi.fn();
    const script = vi.fn();
    const adapter = new GraphEventCompatibilityAdapter({ agent, script });
    await adapter.emit(event('graph_completed'));
    await adapter.emit(event('graph_completed', { sequence: 4 }));
    await adapter.emit(event('graph_failed', { sequence: 5 }));
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent).toHaveBeenCalledWith({ type: 'agent_complete', data: null });
    expect(script).toHaveBeenCalledTimes(1);
  });

  it('keeps authoritative delivery alive when one compatibility sink fails', async () => {
    const diagnostic = vi.fn();
    const session = vi.fn();
    const adapter = new GraphEventCompatibilityAdapter({
      agent: () => { throw new Error('projection sink failed'); },
      session,
      diagnostic,
    });
    await expect(adapter.emit(event('graph_completed'))).resolves.toBeUndefined();
    expect(session).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledOnce();
  });

  it('also contains a failing diagnostic reporter', async () => {
    const adapter = new GraphEventCompatibilityAdapter({
      agent: () => { throw new Error('projection failed'); },
      diagnostic: () => { throw new Error('diagnostic failed'); },
    });
    await expect(adapter.emit(event('graph_completed'))).resolves.toBeUndefined();
  });

  it('projects requires_review to the legacy workflow terminal surface once', async () => {
    const script = vi.fn();
    const adapter = new GraphEventCompatibilityAdapter({ script });
    await adapter.emit(event('graph_waiting', { graphStatus: 'requires_review' }));
    expect(script).toHaveBeenCalledWith({
      runId: 'run-1', sessionId: 'session-1', ts: 100, type: 'run:error',
      data: { error: 'Graph run requires review before it can continue' },
    });
  });

  it('shares one fan-out across migrated facades and flushes one deferred terminal', async () => {
    const agentTeam = vi.fn();
    const autoAgent = vi.fn();
    const adapter = new GraphEventCompatibilityAdapter({ graph: agentTeam }, { deferTerminals: true });
    adapter.subscribe({ graph: autoAgent });
    await adapter.emit(event('node_started', { nodeId: 'node-1', nodeStatus: 'running' }));
    await adapter.emit(event('graph_completed'));
    await adapter.emit(event('graph_failed', { sequence: 5 }));
    expect(agentTeam).toHaveBeenCalledTimes(1);
    expect(autoAgent).toHaveBeenCalledTimes(1);
    await adapter.flushTerminals();
    await adapter.flushTerminals();
    expect(agentTeam).toHaveBeenCalledTimes(2);
    expect(autoAgent).toHaveBeenCalledTimes(2);
    expect(agentTeam.mock.calls[1][0].type).toBe('graph_completed');
  });
});
