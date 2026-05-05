// ============================================================================
// TaskDAG Algorithms - Pure graph functions extracted from TaskDAG god class
// 仅依赖 tasks Map + options，不读 class 状态，便于独立测试和复用
// ============================================================================

import type {
  DAGTask,
  DAGOptions,
  AgentTaskConfig,
} from '../../shared/contract/taskDAG';
import { getPriorityValue } from '../../shared/contract/taskDAG';

/**
 * 拓扑排序（Kahn 算法）。同 in-degree 时按优先级降序。
 * 检测到循环依赖时抛出。
 */
export function computeTopologicalOrder(tasks: Map<string, DAGTask>): string[] {
  const result: string[] = [];
  const inDegree = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, task] of tasks) {
    inDegree.set(id, task.dependencies.length);
    if (task.dependencies.length === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    queue.sort((a, b) => {
      const taskA = tasks.get(a)!;
      const taskB = tasks.get(b)!;
      return getPriorityValue(taskB.priority) - getPriorityValue(taskA.priority);
    });

    const current = queue.shift()!;
    result.push(current);

    const task = tasks.get(current)!;
    for (const depId of task.dependents) {
      const newDegree = inDegree.get(depId)! - 1;
      inDegree.set(depId, newDegree);
      if (newDegree === 0) {
        queue.push(depId);
      }
    }
  }

  if (result.length !== tasks.size) {
    throw new Error('Circular dependency detected in DAG');
  }

  return result;
}

/**
 * 执行层级（同层任务可并行）。每层按优先级降序。
 */
export function computeExecutionLevels(tasks: Map<string, DAGTask>): string[][] {
  const levels: string[][] = [];
  const completed = new Set<string>();
  const remaining = new Set(tasks.keys());

  while (remaining.size > 0) {
    const currentLevel: string[] = [];

    for (const id of remaining) {
      const task = tasks.get(id)!;
      const allDepsCompleted = task.dependencies.every(d => completed.has(d));
      if (allDepsCompleted) {
        currentLevel.push(id);
      }
    }

    if (currentLevel.length === 0) {
      throw new Error('Circular dependency or invalid DAG');
    }

    currentLevel.sort((a, b) => {
      const taskA = tasks.get(a)!;
      const taskB = tasks.get(b)!;
      return getPriorityValue(taskB.priority) - getPriorityValue(taskA.priority);
    });

    levels.push(currentLevel);

    for (const id of currentLevel) {
      completed.add(id);
      remaining.delete(id);
    }
  }

  return levels;
}

/**
 * 关键路径（最长路径，DP 求解）。
 * 调用方负责传入已计算的 topoOrder，避免重复计算。
 */
export function computeCriticalPath(
  tasks: Map<string, DAGTask>,
  options: DAGOptions,
  topoOrder: string[]
): string[] {
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();

  for (const id of topoOrder) {
    dist.set(id, 0);
  }

  for (const id of topoOrder) {
    const task = tasks.get(id)!;
    const currentDist = dist.get(id)!;
    const taskDuration = task.metadata.estimatedDuration || options.defaultTimeout;

    for (const depId of task.dependents) {
      const newDist = currentDist + taskDuration;
      if (newDist > (dist.get(depId) || 0)) {
        dist.set(depId, newDist);
        prev.set(depId, id);
      }
    }
  }

  let maxDist = 0;
  let endNode = '';
  for (const [id, d] of dist) {
    if (d > maxDist) {
      maxDist = d;
      endNode = id;
    }
  }

  const path: string[] = [];
  let current: string | undefined = endNode;
  while (current) {
    path.unshift(current);
    current = prev.get(current);
  }

  return path;
}

export interface DAGValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 校验 DAG 完整性：空、循环、悬空依赖、无入口、agent task 配置、孤立任务。
 */
export function validateDAG(tasks: Map<string, DAGTask>): DAGValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (tasks.size === 0) {
    errors.push('DAG is empty');
    return { valid: false, errors, warnings };
  }

  try {
    computeTopologicalOrder(tasks);
  } catch {
    errors.push('Circular dependency detected');
  }

  for (const task of tasks.values()) {
    for (const depId of task.dependencies) {
      if (!tasks.has(depId)) {
        errors.push(`Task "${task.id}" depends on non-existent task "${depId}"`);
      }
    }
  }

  const hasEntryPoint = Array.from(tasks.values()).some(t => t.dependencies.length === 0);
  if (!hasEntryPoint) {
    errors.push('DAG has no entry point (all tasks have dependencies)');
  }

  for (const task of tasks.values()) {
    if (task.type === 'agent') {
      const config = task.config as AgentTaskConfig;
      if (!config.role) {
        errors.push(`Agent task "${task.id}" missing role`);
      }
      if (!config.prompt) {
        errors.push(`Agent task "${task.id}" missing prompt`);
      }
    }
  }

  for (const task of tasks.values()) {
    if (task.dependencies.length === 0 && task.dependents.length === 0 && tasks.size > 1) {
      warnings.push(`Task "${task.id}" is isolated (no dependencies or dependents)`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
