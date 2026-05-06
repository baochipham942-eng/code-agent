// ============================================================================
// taskDagAlgorithms — 独立 pure-function 测试
// 主路径覆盖在 TaskDAG.test.ts；本文件验证算法可脱离 class 独立调用
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  computeTopologicalOrder,
  computeExecutionLevels,
  computeCriticalPath,
  validateDAG,
} from '../../../src/main/scheduler/taskDagAlgorithms';
import type { DAGTask, DAGOptions } from '../../../src/shared/contract/taskDAG';
import { DEFAULT_DAG_OPTIONS, createDefaultMetadata } from '../../../src/shared/contract/taskDAG';

function makeTask(
  id: string,
  deps: string[] = [],
  overrides: Partial<DAGTask> = {}
): DAGTask {
  return {
    id,
    name: id,
    type: 'agent',
    status: 'pending',
    priority: 'normal',
    metadata: createDefaultMetadata(),
    dependencies: deps,
    dependents: [],
    config: { type: 'agent', role: 'coder', prompt: 'p' },
    ...overrides,
  };
}

function buildTaskMap(tasks: DAGTask[]): Map<string, DAGTask> {
  const map = new Map<string, DAGTask>();
  for (const t of tasks) {
    map.set(t.id, { ...t, dependents: [] });
  }
  for (const t of map.values()) {
    for (const dep of t.dependencies) {
      const depTask = map.get(dep);
      if (depTask && !depTask.dependents.includes(t.id)) {
        depTask.dependents.push(t.id);
      }
    }
  }
  return map;
}

const options: DAGOptions = { ...DEFAULT_DAG_OPTIONS };

describe('computeTopologicalOrder', () => {
  it('单节点直接返回', () => {
    const tasks = buildTaskMap([makeTask('a')]);
    expect(computeTopologicalOrder(tasks)).toEqual(['a']);
  });

  it('线性依赖 a -> b -> c 按依赖顺序', () => {
    const tasks = buildTaskMap([makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])]);
    expect(computeTopologicalOrder(tasks)).toEqual(['a', 'b', 'c']);
  });

  it('同 in-degree 时按优先级降序', () => {
    const tasks = buildTaskMap([
      makeTask('low', [], { priority: 'low' }),
      makeTask('high', [], { priority: 'high' }),
      makeTask('normal', [], { priority: 'normal' }),
    ]);
    expect(computeTopologicalOrder(tasks)).toEqual(['high', 'normal', 'low']);
  });

  it('循环依赖抛错', () => {
    const tasks = buildTaskMap([makeTask('a', ['b']), makeTask('b', ['a'])]);
    expect(() => computeTopologicalOrder(tasks)).toThrow(/Circular dependency/);
  });
});

describe('computeExecutionLevels', () => {
  it('钻石依赖产生 3 层', () => {
    const tasks = buildTaskMap([
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('d', ['b', 'c']),
    ]);
    const levels = computeExecutionLevels(tasks);
    expect(levels).toEqual([['a'], expect.arrayContaining(['b', 'c']), ['d']]);
    expect(levels[1]).toHaveLength(2);
  });

  it('循环依赖抛错', () => {
    const tasks = buildTaskMap([makeTask('a', ['b']), makeTask('b', ['a'])]);
    expect(() => computeExecutionLevels(tasks)).toThrow();
  });
});

describe('computeCriticalPath', () => {
  it('选最长路径而非最短路径', () => {
    const tasks = buildTaskMap([
      makeTask('a', [], { metadata: { ...createDefaultMetadata(), estimatedDuration: 10 } }),
      makeTask('short', ['a'], { metadata: { ...createDefaultMetadata(), estimatedDuration: 1 } }),
      makeTask('long', ['a'], { metadata: { ...createDefaultMetadata(), estimatedDuration: 100 } }),
      makeTask('end', ['short', 'long'], {
        metadata: { ...createDefaultMetadata(), estimatedDuration: 5 },
      }),
    ]);
    const order = computeTopologicalOrder(tasks);
    const path = computeCriticalPath(tasks, options, order);
    expect(path).toContain('long');
    expect(path).not.toContain('short');
  });
});

describe('validateDAG', () => {
  it('空 DAG 报错', () => {
    const result = validateDAG(new Map());
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('DAG is empty');
  });

  it('循环依赖报错', () => {
    const tasks = buildTaskMap([makeTask('a', ['b']), makeTask('b', ['a'])]);
    const result = validateDAG(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /Circular/i.test(e))).toBe(true);
  });

  it('agent task 缺 role/prompt 报错', () => {
    const tasks = buildTaskMap([
      makeTask('a', [], { config: { type: 'agent', role: '', prompt: 'p' } }),
    ]);
    const result = validateDAG(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /missing role/.test(e))).toBe(true);
  });

  it('孤立任务给 warning 不阻断', () => {
    const tasks = buildTaskMap([makeTask('a'), makeTask('b'), makeTask('c', ['a'])]);
    const result = validateDAG(tasks);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /isolated/.test(w))).toBe(true);
  });
});
