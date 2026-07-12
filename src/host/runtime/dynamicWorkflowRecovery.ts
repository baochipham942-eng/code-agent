import { redactSecrets } from '../security/secretRedaction';
import {
  DAGGraphSchedulerAdapter,
  DynamicWorkflowExecutor,
  GraphExecutorRegistry,
  GraphRunner,
  StaleGraphAttemptError,
  type GraphCheckpoint,
  type GraphEventSink,
  type GraphRunSpec,
} from '../orchestration';
import type { ScriptRunHostDeps } from '../agent/scriptRuntime';
import type { RunRehydrationPlan } from './durableRunStores';
import type { RunRegistry } from './runRegistry';
import type { DurableEngineRecoveryHandler } from './durableRecoveryDispatcher';

export interface DynamicWorkflowDurableState {
  schemaVersion: 1;
  engineKind: 'dynamic_workflow';
  runId: string;
  sessionId: string;
  workspace: { root: string; cwd: string; fingerprint: string };
  model: { provider: string; model: string };
  toolProfile: 'readonly';
  graphSpec: GraphRunSpec;
  graphCheckpoint: GraphCheckpoint;
}

export type DynamicWorkflowHostResolution =
  | { ok: true; workspace: string; cwd: string; deps: ScriptRunHostDeps }
  | { ok: false; reason: string };

export interface DynamicWorkflowRecoveryHost {
  resolve(
    state: DynamicWorkflowDurableState,
    plan: RunRehydrationPlan,
    signal: AbortSignal,
  ): Promise<DynamicWorkflowHostResolution>;
  emitGraphEvent?: GraphEventSink;
}

export function createDynamicWorkflowDurableState(
  input: Omit<DynamicWorkflowDurableState, 'schemaVersion' | 'engineKind'>,
): DynamicWorkflowDurableState {
  const state: DynamicWorkflowDurableState = {
    schemaVersion: 1,
    engineKind: 'dynamic_workflow',
    ...structuredClone(input),
  };
  assertDynamicWorkflowDurableState(state);
  return state;
}

export function readDynamicWorkflowDurableState(plan: RunRehydrationPlan): DynamicWorkflowDurableState | null {
  const value = plan.checkpoint?.state;
  try {
    assertDynamicWorkflowDurableState(value);
    return structuredClone(value);
  } catch {
    return null;
  }
}

export function createDynamicWorkflowGraphRecoveryHandler(input: {
  registry: RunRegistry;
  host?: DynamicWorkflowRecoveryHost;
}): DurableEngineRecoveryHandler {
  const active = new Map<string, { runner: GraphRunner; controller: AbortController }>();
  return {
    name: 'dynamic_workflow',
    engineKind: 'dynamic_workflow',
    getDispatchKey(plan) {
      return ['dynamic-graph', plan.envelope.runId, plan.envelope.attempt, plan.envelope.owner?.epoch ?? 'no-owner'].join(':');
    },
    async recover(plan) {
      if (!input.host) return { status: 'requires_review', reason: 'dynamic workflow Host dependency registry is unavailable' };
      const state = readDynamicWorkflowDurableState(plan);
      if (!state) return { status: 'requires_review', reason: 'dynamic workflow checkpoint is missing, unsafe, or unsupported' };
      const identityError = validateRecoveryIdentity(state, plan);
      if (identityError) return { status: 'requires_review', reason: identityError };
      if (state.graphSpec.nodes.some((node) => node.sideEffect !== 'none' && node.sideEffect !== 'read_only')) {
        return { status: 'requires_review', reason: 'dynamic workflow contains an uncertain or write-capable node' };
      }
      const controller = new AbortController();
      let resolved: DynamicWorkflowHostResolution;
      try {
        resolved = await input.host.resolve(state, plan, controller.signal);
      } catch (error) {
        return {
          status: 'requires_review',
          reason: `dynamic workflow Host dependency reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!resolved.ok) return { status: 'requires_review', reason: resolved.reason };
      let handle;
      try {
        handle = input.registry.bindRecoveredHandle(plan, resolved.workspace, resolved.cwd);
      } catch (error) {
        return { status: 'requires_review', reason: error instanceof Error ? error.message : String(error) };
      }
      const graphSpec: GraphRunSpec = {
        ...state.graphSpec,
        runId: plan.envelope.runId,
        sessionId: plan.envelope.sessionId,
        attempt: plan.envelope.attempt,
        trace: handle.traceContext
          ? { traceId: handle.traceContext.traceId, spanId: handle.traceContext.spanId }
          : state.graphSpec.trace,
      };
      const executor = new DynamicWorkflowExecutor({ dependenciesFactory: () => resolved.deps });
      const runner = new GraphRunner({
        scheduler: new DAGGraphSchedulerAdapter(),
        executors: new GraphExecutorRegistry([executor]),
        emit: input.host.emitGraphEvent,
        attemptGuard: ({ runId, attempt }) => {
          const trace = input.registry.getTraceContext(runId);
          return trace?.attempt === attempt && trace.ownerEpoch === plan.envelope.owner?.epoch;
        },
        persistCheckpoint: async (graphCheckpoint) => {
          const nextState = createDynamicWorkflowDurableState({
            ...state,
            graphSpec,
            graphCheckpoint,
          });
          await input.registry.checkpointDurable(plan.envelope.runId, {
            now: Date.now(),
            status: graphCheckpoint.status === 'waiting' || graphCheckpoint.status === 'requires_review' ? 'waiting' : 'running',
            state: nextState,
            engineCursor: {
              schemaVersion: 1,
              graphId: graphCheckpoint.graphId,
              graphAttempt: graphCheckpoint.attempt,
              eventSequence: graphCheckpoint.eventSequence,
            },
            pendingOperations: plan.pendingOperations,
            childRuns: plan.childRuns,
            events: [{
              type: 'dynamic_graph_checkpoint',
              payload: { graphId: graphCheckpoint.graphId, status: graphCheckpoint.status },
              recordedAt: Date.now(),
            }],
          });
        },
      });
      active.set(plan.envelope.runId, { runner, controller });
      try {
        await handle.attach({ cancel: async () => {
          controller.abort('durable_run_cancelled');
          await runner.cancel('durable_run_cancelled');
        } });
        let result;
        try {
          result = await runner.run(graphSpec, state.graphCheckpoint);
        } catch (error) {
          if (error instanceof StaleGraphAttemptError) {
            return { status: 'requires_review', reason: error.message };
          }
          throw error;
        }
        if (result.status === 'waiting' || result.status === 'requires_review') {
          return { status: result.status === 'requires_review' ? 'requires_review' : 'observing', reason: `dynamic graph ${result.status}`, detail: result.checkpoint };
        }
        const terminal = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
        await input.registry.terminalDurable(plan.envelope.runId, {
          now: Date.now(),
          status: terminal,
          reason: terminal === 'failed' ? 'dynamic_graph_failed' : undefined,
          event: {
            type: `dynamic_graph_${terminal}`,
            payload: { graphId: graphSpec.graphId, graphStatus: result.status },
            recordedAt: Date.now(),
          },
        }, handle);
        return {
          status: terminal === 'completed' ? 'recovered' : terminal === 'failed' ? 'failed' : 'requires_review',
          reason: `dynamic graph ${terminal}`,
          detail: result.checkpoint,
        };
      } finally {
        active.delete(plan.envelope.runId);
      }
    },
    async shutdown() {
      await Promise.allSettled([...active.values()].map(async ({ runner, controller }) => {
        controller.abort('recovery_shutdown');
        await runner.cancel('recovery_shutdown');
      }));
      active.clear();
    },
  };
}

export function assertDynamicWorkflowDurableState(value: unknown): asserts value is DynamicWorkflowDurableState {
  assertSafeSerializable(value, 'state');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dynamic workflow state must be an object');
  const state = value as Partial<DynamicWorkflowDurableState>;
  if (state.schemaVersion !== 1 || state.engineKind !== 'dynamic_workflow') throw new Error('unsupported dynamic workflow state');
  if (!state.runId || !state.sessionId || state.toolProfile !== 'readonly') throw new Error('dynamic workflow state identity is incomplete');
  if (!state.workspace?.root || !state.workspace.cwd || !state.workspace.fingerprint) throw new Error('dynamic workflow workspace state is incomplete');
  if (!state.model?.provider || !state.model.model) throw new Error('dynamic workflow model state is incomplete');
  if (!state.graphSpec || !state.graphCheckpoint) throw new Error('dynamic workflow Graph state is incomplete');
  if (state.graphSpec.runId !== state.runId || state.graphSpec.sessionId !== state.sessionId) throw new Error('dynamic workflow Graph identity mismatch');
  if (state.graphCheckpoint.runId !== state.runId || state.graphCheckpoint.sessionId !== state.sessionId) throw new Error('dynamic workflow checkpoint identity mismatch');
  if (state.graphSpec.graphId !== state.graphCheckpoint.graphId) throw new Error('dynamic workflow graphId mismatch');
}

function validateRecoveryIdentity(state: DynamicWorkflowDurableState, plan: RunRehydrationPlan): string | undefined {
  if (plan.envelope.engine.kind !== 'dynamic_workflow') return 'recovery plan is not a dynamic workflow';
  if (!plan.envelope.owner) return 'dynamic workflow recovery has no claimed owner';
  if (state.runId !== plan.envelope.runId || state.sessionId !== plan.envelope.sessionId) return 'dynamic workflow durable identity mismatch';
  if (plan.envelope.engine.workflowId && plan.envelope.engine.workflowId !== state.graphSpec.graphId) return 'dynamic workflow engine cursor identity mismatch';
  if (state.graphCheckpoint.attempt > plan.envelope.attempt) return 'dynamic workflow Graph checkpoint belongs to a future attempt';
  return undefined;
}

function assertSafeSerializable(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${path} is not safely serializable`);
  if (typeof value === 'string') {
    if (redactSecrets(value) !== value) throw new Error(`${path} contains credential material`);
    return;
  }
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenDurableKey(key)) {
      throw new Error(`${path}.${key} is forbidden`);
    }
    assertSafeSerializable(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function isForbiddenDurableKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return normalized === 'env'
    || normalized === 'environment'
    || normalized === 'token'
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
    || normalized.includes('credential')
    || normalized.includes('authorization')
    || normalized.includes('apikey')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('cookie');
}
