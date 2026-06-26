// ============================================================================
// Task DAG - 任务依赖有向无环图
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('TaskDAG');

/**
 * Validate that a set of task dependencies has no cycles.
 * Uses Kahn's algorithm (topological sort).
 *
 * @param dependencies - Map of taskId -> Set of taskIds it's blocked by
 * @returns true if no cycles, false if cycles detected
 */
export function validateNoCycles(dependencies: Map<string, Set<string>>): boolean {
  // Collect all nodes (including those only appearing as dependencies)
  const allNodes = new Set<string>();
  for (const [taskId, blockers] of dependencies) {
    allNodes.add(taskId);
    for (const b of blockers) allNodes.add(b);
  }

  // Compute in-degree for each node
  const inDegree = new Map<string, number>();
  for (const node of allNodes) {
    inDegree.set(node, 0);
  }
  for (const [taskId, blockers] of dependencies) {
    // Each blocker -> taskId edge means taskId has in-degree from blockers
    inDegree.set(taskId, (inDegree.get(taskId) || 0) + blockers.size);
  }

  // Seed queue with zero in-degree nodes
  const queue: string[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) queue.push(node);
  }

  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;

    // For every task that lists `current` as a blocker, decrement in-degree
    for (const [taskId, blockers] of dependencies) {
      if (blockers.has(current)) {
        const newDegree = (inDegree.get(taskId) || 1) - 1;
        inDegree.set(taskId, newDegree);
        if (newDegree === 0) queue.push(taskId);
      }
    }
  }

  const valid = processed === allNodes.size;
  if (!valid) {
    logger.warn(`Cycle detected: processed ${processed}/${allNodes.size} nodes`);
  }
  return valid;
}

/**
 * Get task IDs that are ready to execute (all blockers completed).
 *
 * @param blockedBy - Map of taskId -> Set of blocker taskIds
 * @param completedTasks - Set of completed task IDs
 * @returns Array of task IDs ready to start
 */
export function getReadyTasks(
  blockedBy: Map<string, Set<string>>,
  completedTasks: Set<string>
): string[] {
  const ready: string[] = [];

  for (const [taskId, blockers] of blockedBy) {
    // Skip already-completed tasks
    if (completedTasks.has(taskId)) continue;

    let allBlockersCompleted = true;
    for (const blocker of blockers) {
      if (!completedTasks.has(blocker)) {
        allBlockersCompleted = false;
        break;
      }
    }
    if (allBlockersCompleted) {
      ready.push(taskId);
    }
  }

  return ready;
}

/**
 * Detect which tasks are involved in a cycle (for error reporting).
 * Uses DFS to find all cycles.
 *
 * @param dependencies - Map of taskId -> Set of taskIds it's blocked by
 * @returns Array of taskId arrays, each representing a cycle
 */
export function detectCycles(dependencies: Map<string, Set<string>>): string[][] {
  // Build adjacency: blocker -> [tasks it blocks]
  // If taskId is blockedBy blocker, then blocker -> taskId is a directed edge
  const adjacency = new Map<string, Set<string>>();
  const allNodes = new Set<string>();

  for (const [taskId, blockers] of dependencies) {
    allNodes.add(taskId);
    for (const blocker of blockers) {
      allNodes.add(blocker);
      if (!adjacency.has(blocker)) adjacency.set(blocker, new Set());
      adjacency.get(blocker)!.add(taskId);
    }
  }

  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current DFS path
  const BLACK = 2; // fully processed

  const color = new Map<string, number>();
  for (const node of allNodes) color.set(node, WHITE);

  const parent = new Map<string, string | null>();
  const cycles: string[][] = [];

  function dfs(node: string): void {
    color.set(node, GRAY);

    const neighbors = adjacency.get(node) || new Set();
    for (const neighbor of neighbors) {
      const c = color.get(neighbor) || WHITE;
      if (c === GRAY) {
        // Back edge found - extract cycle
        const cycle: string[] = [neighbor];
        let current = node;
        while (current !== neighbor) {
          cycle.push(current);
          current = parent.get(current) || neighbor; // safety fallback
        }
        cycle.reverse();
        cycles.push(cycle);
      } else if (c === WHITE) {
        parent.set(neighbor, node);
        dfs(neighbor);
      }
    }

    color.set(node, BLACK);
  }

  for (const node of allNodes) {
    if (color.get(node) === WHITE) {
      parent.set(node, null);
      dfs(node);
    }
  }

  if (cycles.length > 0) {
    logger.warn(`Detected ${cycles.length} cycle(s) in task dependencies`);
  }

  return cycles;
}
