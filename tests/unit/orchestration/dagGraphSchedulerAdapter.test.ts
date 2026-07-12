import { describe, expect, it } from 'vitest';
import {
  DAGGraphSchedulerAdapter,
  type GraphNode,
  type GraphRunSpec,
} from '../../../src/host/orchestration';

function node(nodeId: string, dependencies: string[] = [], extra: Partial<GraphNode> = {}): GraphNode {
  return {
    nodeId,
    kind: 'test',
    executorRef: 'test',
    input: null,
    dependencies,
    sideEffect: 'none',
    ...extra,
  };
}

function spec(nodes: GraphNode[]): GraphRunSpec {
  return {
    graphId: 'graph',
    runId: 'run',
    sessionId: 'session',
    attempt: 1,
    nodes,
    schedulerPolicy: { maxConcurrency: 2 },
  };
}

describe('DAGGraphSchedulerAdapter', () => {
  it('uses TaskDAG validation and fails closed for cycles and missing dependencies', () => {
    expect(() => new DAGGraphSchedulerAdapter().initialize(spec([
      node('a', ['b']), node('b', ['a']),
    ]))).toThrow(/Circular|cycle/);
    expect(() => new DAGGraphSchedulerAdapter().initialize(spec([
      node('a', ['missing']),
    ]))).toThrow('missing');
  });

  it('schedules ready nodes by dependency and priority', () => {
    const scheduler = new DAGGraphSchedulerAdapter();
    scheduler.initialize(spec([
      node('low', [], { priority: 0 }),
      node('high', [], { priority: 3 }),
      node('after', ['high']),
    ]));
    expect(scheduler.nextReadyNodes(1).map((item) => item.nodeId)).toEqual(['high']);
    scheduler.markRunning('high', 1);
    scheduler.applyResult({ nodeId: 'high', status: 'completed', attempts: 1, completedAt: 2 });
    expect(scheduler.nextReadyNodes(2).map((item) => item.nodeId)).toEqual(['low', 'after']);
  });

  it('continues past optional failure and skips descendants of required failure', () => {
    const optional = new DAGGraphSchedulerAdapter();
    optional.initialize(spec([node('optional', [], { optional: true }), node('next', ['optional'])]));
    optional.markRunning('optional', 1);
    optional.applyResult({ nodeId: 'optional', status: 'failed', attempts: 1, completedAt: 2 });
    expect(optional.nextReadyNodes(1)[0]?.nodeId).toBe('next');

    const required = new DAGGraphSchedulerAdapter();
    required.initialize(spec([node('required'), node('next', ['required']), node('last', ['next'])]));
    required.markRunning('required', 1);
    required.applyResult({ nodeId: 'required', status: 'failed', attempts: 1, completedAt: 2 });
    expect(required.snapshot().nodes.map((state) => [state.nodeId, state.status])).toEqual([
      ['required', 'failed'], ['next', 'skipped'], ['last', 'skipped'],
    ]);
  });

  it('restores completed nodes and safely classifies interrupted side effects', () => {
    const graph = spec([
      node('done'),
      node('read', ['done'], { sideEffect: 'read_only' }),
      node('write', ['done'], { sideEffect: 'unknown' }),
    ]);
    const scheduler = new DAGGraphSchedulerAdapter();
    scheduler.restore(graph, {
      version: 1,
      cancelled: false,
      nodes: [
        { nodeId: 'done', status: 'completed', attempts: 1 },
        { nodeId: 'read', status: 'running', attempts: 1 },
        { nodeId: 'write', status: 'running', attempts: 1 },
      ],
    });
    expect(scheduler.snapshot().nodes.map((state) => [state.nodeId, state.status])).toEqual([
      ['done', 'completed'], ['read', 'ready'], ['write', 'requires_review'],
    ]);
    expect(scheduler.nextReadyNodes(2).map((item) => item.nodeId)).toEqual(['read']);
  });

  it('keeps scheduler instances run-scoped and cancellation isolated', () => {
    const left = new DAGGraphSchedulerAdapter();
    const right = new DAGGraphSchedulerAdapter();
    left.initialize(spec([node('same')]));
    right.initialize({ ...spec([node('same')]), graphId: 'right', runId: 'right' });
    expect(left.cancel()).toEqual(['same']);
    expect(left.snapshot().nodes[0].status).toBe('cancelled');
    expect(right.snapshot().nodes[0].status).toBe('ready');
  });

  it('accepts explicit edges without duplicating dependencies', () => {
    const scheduler = new DAGGraphSchedulerAdapter();
    scheduler.initialize({
      ...spec([node('a'), node('b')]),
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
    });
    expect(scheduler.nextReadyNodes(2).map((item) => item.nodeId)).toEqual(['a']);
  });
});
