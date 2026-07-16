import { describe, expect, it, vi } from 'vitest';
import {
  GraphExecutorRegistry,
  GraphRunner,
  StaleGraphAttemptError,
  type GraphCheckpoint,
  type GraphExecutorPort,
  type GraphNode,
  type GraphNodeResult,
  type GraphRunSpec,
  type GraphSchedulerApplyResult,
  type GraphSchedulerNodeState,
  type GraphSchedulerPort,
  type GraphSchedulerSnapshot,
  type GraphTraceContext,
  type GraphTracePort,
} from '../../../src/host/orchestration';

class TestScheduler implements GraphSchedulerPort {
  private spec!: GraphRunSpec;
  private states = new Map<string, GraphSchedulerNodeState>();
  private cancelled = false;

  initialize(spec: GraphRunSpec): void {
    this.assertAcyclic(spec);
    this.spec = spec;
    this.states = new Map(spec.nodes.map((node) => [node.nodeId, {
      nodeId: node.nodeId,
      status: node.dependencies.length === 0 ? 'ready' : 'queued',
      attempts: 0,
    }]));
    this.cancelled = false;
  }

  nextReadyNodes(limit: number): GraphNode[] {
    this.refreshReady();
    return this.spec.nodes
      .filter((node) => this.states.get(node.nodeId)?.status === 'ready')
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, limit);
  }

  markRunning(nodeId: string, startedAt: number): void {
    const state = this.requireState(nodeId);
    if (state.status !== 'ready') throw new Error(`${nodeId} is not ready`);
    state.status = 'running';
    state.startedAt = startedAt;
  }

  applyResult(result: GraphSchedulerApplyResult): void {
    const state = this.requireState(result.nodeId);
    Object.assign(state, result);
    if (result.status === 'failed') this.skipRequiredDependents(result.nodeId);
    this.refreshReady();
  }

  cancel(nodeId?: string): string[] {
    const cancelled: string[] = [];
    for (const state of this.states.values()) {
      if (nodeId && state.nodeId !== nodeId) continue;
      if (['completed', 'failed', 'cancelled', 'skipped', 'requires_review'].includes(state.status)) continue;
      state.status = 'cancelled';
      cancelled.push(state.nodeId);
    }
    this.cancelled = true;
    return cancelled;
  }

  snapshot(): GraphSchedulerSnapshot {
    return {
      version: 1,
      nodes: [...this.states.values()].map((state) => ({ ...state })),
      cancelled: this.cancelled,
    };
  }

  restore(spec: GraphRunSpec, snapshot: GraphSchedulerSnapshot): void {
    this.assertAcyclic(spec);
    this.spec = spec;
    this.states = new Map(snapshot.nodes.map((state) => [state.nodeId, { ...state }]));
    this.cancelled = snapshot.cancelled;
    this.refreshReady();
  }

  private refreshReady(): void {
    for (const node of this.spec.nodes) {
      const state = this.requireState(node.nodeId);
      if (state.status !== 'queued') continue;
      const satisfied = node.dependencies.every((dependency) => {
        const dependencyState = this.requireState(dependency);
        const dependencyNode = this.spec.nodes.find((candidate) => candidate.nodeId === dependency)!;
        return dependencyState.status === 'completed'
          || (dependencyNode.optional === true && dependencyState.status === 'failed');
      });
      if (satisfied) state.status = 'ready';
    }
  }

  private skipRequiredDependents(nodeId: string): void {
    const node = this.spec.nodes.find((candidate) => candidate.nodeId === nodeId)!;
    if (node.optional === true || node.required === false) return;
    for (const dependent of this.spec.nodes.filter((candidate) => candidate.dependencies.includes(nodeId))) {
      const state = this.requireState(dependent.nodeId);
      if (state.status === 'queued' || state.status === 'ready') {
        state.status = 'skipped';
        this.skipRequiredDependents(dependent.nodeId);
      }
    }
  }

  private requireState(nodeId: string): GraphSchedulerNodeState {
    const state = this.states.get(nodeId);
    if (!state) throw new Error(`Unknown node ${nodeId}`);
    return state;
  }

  private assertAcyclic(spec: GraphRunSpec): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Graph contains a cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const node = spec.nodes.find((candidate) => candidate.nodeId === id);
      for (const dependency of node?.dependencies ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const node of spec.nodes) visit(node.nodeId);
  }
}

function node(nodeId: string, dependencies: string[] = [], overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    nodeId,
    kind: 'test',
    executorRef: 'test',
    input: { nodeId },
    dependencies,
    sideEffect: 'none',
    ...overrides,
  };
}

function spec(nodes: GraphNode[], overrides: Partial<GraphRunSpec> = {}): GraphRunSpec {
  return {
    graphId: 'graph-1',
    runId: 'run-1',
    sessionId: 'session-1',
    attempt: 1,
    nodes,
    schedulerPolicy: { maxConcurrency: 4 },
    ...overrides,
  };
}

function executor(
  execute: GraphExecutorPort['execute'],
  cancel: GraphExecutorPort['cancel'] = vi.fn(),
  recover?: GraphExecutorPort['recover'],
): GraphExecutorPort {
  return { id: 'test', canExecute: () => true, execute, cancel, recover };
}

function runner(input: {
  execute: GraphExecutorPort['execute'];
  cancel?: GraphExecutorPort['cancel'];
  events?: Array<{ type: string; nodeId?: string }>;
  checkpoints?: GraphCheckpoint[];
  guard?: () => boolean;
  trace?: GraphTracePort;
  recover?: GraphExecutorPort['recover'];
  scheduler?: GraphSchedulerPort;
  sleep?: (ms: number) => Promise<void>;
}) {
  return new GraphRunner({
    scheduler: input.scheduler ?? new TestScheduler(),
    executors: new GraphExecutorRegistry([executor(input.execute, input.cancel, input.recover)]),
    emit: (event) => { input.events?.push({ type: event.type, nodeId: event.nodeId }); },
    persistCheckpoint: (checkpoint) => { input.checkpoints?.push(structuredClone(checkpoint)); },
    attemptGuard: input.guard,
    trace: input.trace,
    sleep: input.sleep ?? (async () => undefined),
  });
}

describe('GraphRunner', () => {
  it('executes dependencies in order and passes dependency results', async () => {
    const order: string[] = [];
    const run = runner({ execute: async (current, context) => {
      order.push(current.nodeId);
      if (current.nodeId === 'b') expect(context.dependencyResults.a?.output).toBe('a-output');
      return { status: 'completed', output: `${current.nodeId}-output` };
    } });

    const result = await run.run(spec([node('a'), node('b', ['a'])]));
    expect(order).toEqual(['a', 'b']);
    expect(result.status).toBe('completed');
  });

  it('runs independent nodes concurrently up to the graph limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const releases: Array<() => void> = [];
    const run = runner({ execute: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return { status: 'completed' };
    } });
    const promise = run.run(spec([node('a'), node('b')], { schedulerPolicy: { maxConcurrency: 2 } }));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await promise;
    expect(maxRunning).toBe(2);
  });

  it('fails closed on a cycle before executing a node', async () => {
    const execute = vi.fn(async (): Promise<GraphNodeResult> => ({ status: 'completed' }));
    await expect(runner({ execute }).run(spec([node('a', ['b']), node('b', ['a'])])))
      .rejects.toThrow('cycle');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails the graph when a required node fails and skips its dependent', async () => {
    const events: Array<{ type: string; nodeId?: string }> = [];
    const result = await runner({
      events,
      execute: async (current) => current.nodeId === 'a'
        ? { status: 'failed', error: 'boom' }
        : { status: 'completed' },
    }).run(spec([node('a'), node('b', ['a'])]));
    expect(result.status).toBe('failed');
    expect(result.checkpoint.nodes.find((state) => state.nodeId === 'b')?.status).toBe('skipped');
    expect(events).toContainEqual({ type: 'node_skipped', nodeId: 'b' });
  });

  it('allows an optional node failure and continues its dependent', async () => {
    const executed: string[] = [];
    const result = await runner({ execute: async (current) => {
      executed.push(current.nodeId);
      return current.nodeId === 'optional'
        ? { status: 'failed', error: 'advisory failed' }
        : { status: 'completed' };
    } }).run(spec([node('optional', [], { optional: true }), node('next', ['optional'])]));
    expect(result.status).toBe('completed');
    expect(executed).toEqual(['optional', 'next']);
  });

  it('cancels only the target graph and invokes its executor cancel port', async () => {
    const resolvers = new Map<string, () => void>();
    const cancelA = vi.fn();
    const graphA = runner({
      cancel: cancelA,
      execute: async (_node, context) => new Promise<GraphNodeResult>((resolve) => {
        resolvers.set(context.runId, () => resolve({ status: 'cancelled' }));
      }),
    });
    const graphB = runner({ execute: async () => ({ status: 'completed' }) });
    const runA = graphA.run(spec([node('a')]));
    const runB = graphB.run(spec([node('b')], { graphId: 'graph-2', runId: 'run-2' }));
    await vi.waitFor(() => expect(resolvers.has('run-1')).toBe(true));
    await graphA.cancel('user');
    resolvers.get('run-1')?.();
    expect((await runA).status).toBe('cancelled');
    expect((await runB).status).toBe('completed');
    expect(cancelA).toHaveBeenCalledTimes(1);
  });

  it('routes cancellation of a waiting node back to its executor', async () => {
    const cancel = vi.fn();
    const run = runner({ execute: async () => ({ status: 'waiting' }), cancel });
    const result = await run.run(spec([node('waiting')]));
    expect(result.status).toBe('waiting');
    await run.cancel('user');
    expect(cancel).toHaveBeenCalledOnce();
    expect(run.getCheckpoint()?.status).toBe('cancelled');
  });

  it('retries with the same logical node id', async () => {
    const calls: Array<{ nodeId: string; nodeAttempt: number }> = [];
    const result = await runner({ execute: async (current, context) => {
      calls.push({ nodeId: current.nodeId, nodeAttempt: context.nodeAttempt });
      return context.nodeAttempt === 1
        ? { status: 'failed', error: 'transient', retryable: true }
        : { status: 'completed' };
    } }).run(spec([node('a', [], { retryPolicy: { maxAttempts: 2 } })]));
    expect(result.status).toBe('completed');
    expect(calls).toEqual([{ nodeId: 'a', nodeAttempt: 1 }, { nodeId: 'a', nodeAttempt: 2 }]);
  });

  it('keeps a retry in backoff active when a sibling wakes the run loop', async () => {
    const scheduler = new TestScheduler();
    const nextReadyNodes = scheduler.nextReadyNodes.bind(scheduler);
    let schedulerPasses = 0;
    let resolveSiblingWakePass!: () => void;
    const siblingWakePass = new Promise<void>((resolve) => { resolveSiblingWakePass = resolve; });
    vi.spyOn(scheduler, 'nextReadyNodes').mockImplementation((limit) => {
      const ready = nextReadyNodes(limit);
      schedulerPasses++;
      if (schedulerPasses === 2) queueMicrotask(resolveSiblingWakePass);
      return ready;
    });

    let releaseBackoff!: () => void;
    let resolveBackoffEntered!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { resolveBackoffEntered = resolve; });
    const backoffGate = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    let settleSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => { settleSibling = resolve; });
    let resolveFirstAttemptFinished!: () => void;
    const firstAttemptFinished = new Promise<void>((resolve) => { resolveFirstAttemptFinished = resolve; });
    const aAttempts: number[] = [];
    const aStarts: GraphTraceContext[] = [];
    const trace: GraphTracePort = {
      startGraph: vi.fn(() => ({ traceId: 'trace', spanId: 'graph' })),
      startNode: vi.fn((_spec, current) => {
        const nodeTrace = { traceId: 'trace', spanId: `${current.nodeId}-${current.nodeId === 'a' ? aStarts.length + 1 : 1}` };
        if (current.nodeId === 'a') aStarts.push(nodeTrace);
        return nodeTrace;
      }),
      endNode: vi.fn((nodeTrace) => {
        if (nodeTrace === aStarts[0]) resolveFirstAttemptFinished();
      }),
      endGraph: vi.fn(),
    };
    const run = runner({
      scheduler,
      trace,
      sleep: async () => {
        resolveBackoffEntered();
        await backoffGate;
      },
      execute: async (current, context) => {
        if (current.nodeId === 'b') {
          await siblingGate;
          return { status: 'completed' };
        }
        aAttempts.push(context.nodeAttempt);
        return context.nodeAttempt === 1
          ? { status: 'failed', error: 'transient', retryable: true }
          : { status: 'completed' };
      },
    });

    const runPromise = run.run(spec([
      node('a', [], { retryPolicy: { maxAttempts: 2, backoffMs: 100 } }),
      node('b'),
    ], { schedulerPolicy: { maxConcurrency: 2 } }));
    await backoffEntered;
    settleSibling();
    await siblingWakePass;
    const launchesDuringBackoff = aStarts.length;
    releaseBackoff();
    await firstAttemptFinished;
    const result = await runPromise;

    expect(launchesDuringBackoff, 'attempt 2 launched before backoff was released').toBe(1);
    expect(aAttempts).toEqual([1, 2]);
    expect(result.status).toBe('completed');
  });

  it('moves an uncertain side effect to requires_review without retry', async () => {
    const execute = vi.fn(async (): Promise<GraphNodeResult> => ({
      status: 'failed', error: 'connection lost', retryable: true, sideEffectState: 'unknown',
    }));
    const result = await runner({ execute }).run(spec([
      node('write', [], { sideEffect: 'unknown', retryPolicy: { maxAttempts: 3 } }),
    ]));
    expect(result.status).toBe('requires_review');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute a completed checkpoint node again', async () => {
    const firstExecute = vi.fn(async (): Promise<GraphNodeResult> => ({ status: 'completed', output: 'done' }));
    const first = await runner({ execute: firstExecute }).run(spec([node('a')]));
    const recoveredExecute = vi.fn(async (): Promise<GraphNodeResult> => ({ status: 'completed' }));
    const recovered = await runner({ execute: recoveredExecute }).run(spec([node('a')]), {
      ...first.checkpoint,
      status: 'running',
      terminalEventType: undefined,
    });
    expect(recovered.status).toBe('completed');
    expect(recoveredExecute).not.toHaveBeenCalled();
  });

  it('persists an in-flight executor cursor and uses recover for an interrupted node', async () => {
    const initial = await runner({ execute: async () => ({ status: 'completed' }) }).run(spec([node('a')]));
    const interrupted = structuredClone(initial.checkpoint);
    interrupted.status = 'running';
    interrupted.terminalEventType = undefined;
    interrupted.nodes[0].status = 'running';
    interrupted.nodes[0].result = { status: 'waiting', checkpoint: { cursor: 'engine-1' } };
    const scheduler = interrupted.scheduler as unknown as { nodes: Array<{ status: string }> };
    // Production DAG adapter normalizes interrupted running -> ready during restore.
    // TestScheduler reaches the same launch state from queued while the original
    // Graph checkpoint still records the interrupted running ownership.
    scheduler.nodes[0].status = 'queued';
    const execute = vi.fn(async (): Promise<GraphNodeResult> => ({ status: 'failed' }));
    const recover = vi.fn(async (_node, _checkpoint, context): Promise<GraphNodeResult> => {
      expect(context.checkpoint?.nodes[0].result?.checkpoint).toEqual({ cursor: 'engine-1' });
      return { status: 'completed', output: 'resumed' };
    });
    const result = await runner({ execute, recover }).run(spec([node('a')]), interrupted);
    expect(result.status).toBe('completed');
    expect(recover).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits exactly one terminal graph event', async () => {
    const events: Array<{ type: string; nodeId?: string }> = [];
    const result = await runner({ events, execute: async () => ({ status: 'completed' }) })
      .run(spec([node('a')]));
    expect(result.status).toBe('completed');
    expect(events.filter((event) => event.type === 'graph_completed')).toHaveLength(1);
  });

  it('fences a stale attempt before it can apply a node result', async () => {
    let current = true;
    let release!: () => void;
    const checkpoints: GraphCheckpoint[] = [];
    const run = runner({
      checkpoints,
      guard: () => current,
      execute: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: 'completed' };
      },
    });
    const promise = run.run(spec([node('a')]));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const writesBeforeFence = checkpoints.length;
    current = false;
    release();
    await expect(promise).rejects.toBeInstanceOf(StaleGraphAttemptError);
    expect(checkpoints).toHaveLength(writesBeforeFence);
  });

  it('creates child node spans from the graph span', async () => {
    const graphTrace: GraphTraceContext = { traceId: 'trace', spanId: 'graph-span' };
    const nodeTrace: GraphTraceContext = { traceId: 'trace', spanId: 'node-span' };
    const trace: GraphTracePort = {
      startGraph: vi.fn(() => graphTrace),
      startNode: vi.fn((_spec, _node, parent) => {
        expect(parent).toEqual(graphTrace);
        return nodeTrace;
      }),
      endNode: vi.fn(),
      endGraph: vi.fn(),
    };
    const execute = vi.fn(async (_node, context): Promise<GraphNodeResult> => {
      expect(context.trace).toEqual(nodeTrace);
      return { status: 'completed' };
    });
    await runner({ execute, trace }).run(spec([node('a')]));
    expect(trace.startNode).toHaveBeenCalledTimes(1);
    expect(trace.endGraph).toHaveBeenCalledWith(graphTrace, 'completed');
  });
});
