import {
  getSwarmRunScopeKey,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import { ParallelAgentCoordinator } from './parallelAgentCoordinator';
import {
  LEGACY_COORDINATOR_SCOPE,
  type CompletedParallelCoordinatorSnapshot,
  type CoordinatorConfig,
  type ParallelCoordinatorTerminalStatus,
} from './parallelAgentCoordinatorTypes';

/** Explicit scope container. The container is process-wide; mutable run state is not. */
export class ParallelAgentCoordinatorRegistry {
  private static readonly MAX_COMPLETED_SNAPSHOTS = 100;
  private coordinators = new Map<string, ParallelAgentCoordinator>();
  private completedSnapshots = new Map<string, CompletedParallelCoordinatorSnapshot>();

  private assertRunTreeInvariant(scope: SwarmRunScope): void {
    for (const coordinator of this.coordinators.values()) {
      const existing = coordinator.getScope();
      if (
        existing?.sessionId === scope.sessionId
        && existing.runId === scope.runId
        && existing.treeId !== scope.treeId
      ) {
        throw new Error(
          `Coordinator run ${scope.sessionId}/${scope.runId} is already bound to tree ${existing.treeId}.`,
        );
      }
    }
    for (const snapshot of this.completedSnapshots.values()) {
      if (
        snapshot.scope.sessionId === scope.sessionId
        && snapshot.scope.runId === scope.runId
        && snapshot.scope.treeId !== scope.treeId
      ) {
        throw new Error(
          `Coordinator run ${scope.sessionId}/${scope.runId} is already terminal on tree ${snapshot.scope.treeId}.`,
        );
      }
    }
  }

  get(scope: SwarmRunScope): ParallelAgentCoordinator | undefined {
    return this.coordinators.get(getSwarmRunScopeKey(scope));
  }

  getByRun(ref: SwarmRunRef): ParallelAgentCoordinator | undefined {
    for (const coordinator of this.coordinators.values()) {
      const scope = coordinator.getScope();
      if (scope?.sessionId === ref.sessionId && scope.runId === ref.runId) {
        return coordinator;
      }
    }
    return undefined;
  }

  getOrCreate(
    scope: SwarmRunScope,
    config: Partial<CoordinatorConfig> = {},
  ): ParallelAgentCoordinator {
    this.assertRunTreeInvariant(scope);
    const key = getSwarmRunScopeKey(scope);
    if (this.completedSnapshots.has(key)) {
      throw new Error(`Coordinator run ${scope.sessionId}/${scope.runId} is already terminal.`);
    }
    let coordinator = this.coordinators.get(key);
    if (!coordinator) {
      coordinator = new ParallelAgentCoordinator(config, scope);
      this.coordinators.set(key, coordinator);
    }
    return coordinator;
  }

  replace(
    scope: SwarmRunScope,
    config: Partial<CoordinatorConfig> = {},
  ): ParallelAgentCoordinator {
    this.assertRunTreeInvariant(scope);
    const key = getSwarmRunScopeKey(scope);
    if (this.completedSnapshots.has(key)) {
      throw new Error(`Coordinator run ${scope.sessionId}/${scope.runId} is already terminal.`);
    }
    const previous = this.coordinators.get(key);
    previous?.reset();
    const coordinator = new ParallelAgentCoordinator(config, scope);
    this.coordinators.set(key, coordinator);
    return coordinator;
  }

  abortRun(ref: SwarmRunRef, reason = 'run_cancelled'): boolean {
    let aborted = false;
    for (const coordinator of this.coordinators.values()) {
      const scope = coordinator.getScope();
      if (scope?.sessionId !== ref.sessionId || scope.runId !== ref.runId) continue;
      coordinator.abortAllRunning(reason);
      aborted = true;
    }
    return aborted;
  }

  abortSession(sessionId: string, reason = 'session_cancelled'): number {
    let aborted = 0;
    for (const coordinator of this.coordinators.values()) {
      if (coordinator.getScope()?.sessionId !== sessionId) continue;
      coordinator.abortAllRunning(reason);
      aborted += 1;
    }
    return aborted;
  }

  finalize(
    scope: SwarmRunScope,
    status: ParallelCoordinatorTerminalStatus,
    completedAt = Date.now(),
  ): CompletedParallelCoordinatorSnapshot | undefined {
    const key = getSwarmRunScopeKey(scope);
    const existing = this.completedSnapshots.get(key);
    if (existing) return existing;

    const coordinator = this.coordinators.get(key);
    if (!coordinator) return undefined;

    const tasks = coordinator.getTaskSnapshots().map((task) => Object.freeze({
      taskId: task.taskId,
      role: task.role,
      status: task.status,
      ...(task.error ? { error: task.error } : {}),
      ...(task.failureCode ? { failureCode: task.failureCode } : {}),
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(typeof task.duration === 'number' ? { duration: task.duration } : {}),
    }));
    const snapshot = Object.freeze({
      scope: Object.freeze({ ...scope }),
      status,
      completedAt,
      tasks: Object.freeze(tasks),
    });

    this.coordinators.delete(key);
    this.completedSnapshots.set(key, snapshot);
    while (this.completedSnapshots.size > ParallelAgentCoordinatorRegistry.MAX_COMPLETED_SNAPSHOTS) {
      const oldestKey = this.completedSnapshots.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.completedSnapshots.delete(oldestKey);
    }
    return snapshot;
  }

  getCompleted(ref: SwarmRunRef): CompletedParallelCoordinatorSnapshot | undefined {
    for (const snapshot of this.completedSnapshots.values()) {
      if (snapshot.scope.sessionId === ref.sessionId && snapshot.scope.runId === ref.runId) {
        return snapshot;
      }
    }
    return undefined;
  }

  /** Global shutdown only. Run/user cancellation must use abortRun/abortSession. */
  abortAll(reason = 'app_shutdown'): number {
    let aborted = 0;
    for (const coordinator of this.coordinators.values()) {
      coordinator.abortAllRunning(reason);
      aborted += 1;
    }
    return aborted;
  }

  delete(scope: SwarmRunScope, reset = false): boolean {
    const key = getSwarmRunScopeKey(scope);
    const coordinator = this.coordinators.get(key);
    if (!coordinator) return false;
    if (reset) coordinator.reset();
    return this.coordinators.delete(key);
  }

  clear(): void {
    for (const coordinator of this.coordinators.values()) {
      coordinator.reset();
    }
    this.coordinators.clear();
    this.completedSnapshots.clear();
  }

  size(): number {
    return this.coordinators.size;
  }
}

const coordinatorRegistry = new ParallelAgentCoordinatorRegistry();

export function getParallelAgentCoordinatorRegistry(): ParallelAgentCoordinatorRegistry {
  return coordinatorRegistry;
}

/** Legacy callers get an isolated legacy bucket; Agent Team callers must pass a scope. */
export function getParallelAgentCoordinator(
  scope: SwarmRunScope = LEGACY_COORDINATOR_SCOPE,
): ParallelAgentCoordinator {
  return coordinatorRegistry.getOrCreate(scope);
}

export function initParallelAgentCoordinator(
  config: Partial<CoordinatorConfig> = {},
  scope: SwarmRunScope = LEGACY_COORDINATOR_SCOPE,
): ParallelAgentCoordinator {
  return coordinatorRegistry.replace(scope, config);
}

export function resetParallelAgentCoordinators(): void {
  coordinatorRegistry.clear();
}
