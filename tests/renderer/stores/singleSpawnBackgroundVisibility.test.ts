import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishBackgroundSubagentVisibility, resolveSingleSpawnRunScope } from '../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground';
import { getEventBus } from '../../../src/host/services/eventing/bus';
import type { BusEvent } from '../../../src/host/protocol/events/busTypes';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';
import {
  resetSingleSpawnVisibilityRegistry,
  resolveSingleSpawnVisibility,
} from '../../../src/host/agent/singleSpawnVisibilityRegistry';
import { selectHasStoppableSwarmWork, useSwarmStore } from '../../../src/renderer/stores/swarmStore';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('single spawn background visibility', () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    useSwarmStore.getState().reset();
    useSwarmStore.getState().activateScope('session-single');
    unsubscribe = getEventBus().subscribe<SwarmEvent>('swarm', (event: BusEvent<SwarmEvent>) => {
      useSwarmStore.getState().handleEvent(event.data);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    useSwarmStore.getState().reset();
    resetSingleSpawnVisibilityRegistry();
  });

  it('emitted single-agent lifecycle makes the existing composer stop predicate live, then clears it', async () => {
    const work = deferred<SubagentResult>();
    const scope = resolveSingleSpawnRunScope({
      sessionId: 'session-single',
      runId: 'native-parent',
    }, 'session-single', 'agent_dynamic_test');
    expect(scope).toEqual({
      sessionId: 'session-single',
      runId: 'single_agent_dynamic_test',
      treeId: 'session-single',
      parentNativeRunId: 'native-parent',
    });

    publishBackgroundSubagentVisibility({
      promise: work.promise,
      scope,
      agentId: 'agent-visible',
      agentName: 'Visible Agent',
      role: 'dynamic',
      task: 'keep working',
      startedAt: 100,
      ownsRunLifecycle: true,
    });

    expect(selectHasStoppableSwarmWork(useSwarmStore.getState(), 'session-single')).toBe(true);
    expect(useSwarmStore.getState().agents).toEqual([
      expect.objectContaining({ id: 'agent-visible', status: 'running' }),
    ]);

    work.resolve({ success: true, output: 'done', toolsUsed: [], iterations: 1 });
    await work.promise;
    await Promise.resolve();

    expect(selectHasStoppableSwarmWork(useSwarmStore.getState(), 'session-single')).toBe(false);
    expect(useSwarmStore.getState()).toMatchObject({
      isRunning: false,
      agents: [expect.objectContaining({ id: 'agent-visible', status: 'completed' })],
    });
  });

  it('routes the synthetic visibility run to the stable legacy agent id only while work is live', async () => {
    const scope = resolveSingleSpawnRunScope({
      sessionId: 'session-single',
      runId: 'native-parent',
    }, 'session-single', 'agent_dynamic_cancel');
    expect(scope).toBeDefined();
    const work = deferred<SubagentResult>();
    const agentId = 'agent_dynamic_cancel';
    publishBackgroundSubagentVisibility({
      promise: work.promise,
      scope,
      agentId,
      agentName: 'Cancelable Agent',
      role: 'dynamic',
      task: 'long task',
      startedAt: 100,
      ownsRunLifecycle: true,
    });

    expect(resolveSingleSpawnVisibility(scope!)).toEqual({
      scope,
      agentIds: [agentId],
    });

    work.resolve({ success: true, output: 'done', toolsUsed: [], iterations: 1 });
    await work.promise;
    await Promise.resolve();
    expect(resolveSingleSpawnVisibility(scope!)).toBeUndefined();
  });
});
