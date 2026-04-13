// ============================================================================
// ParallelAgentCoordinator Tests
// 覆盖依赖排序、SharedContext 合并、事件发射、失败传播、retryTask
// mock getSubagentExecutor 返回假 result
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock subagentExecutor
// ---------------------------------------------------------------------------

const executorState = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock('../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executorState.executeMock,
  }),
}));

// ---------------------------------------------------------------------------
// Mock scheduler module — executeWithDAG 依赖它
// ---------------------------------------------------------------------------

const schedulerState = vi.hoisted(() => ({
  executeMock: vi.fn(),
  capturedDAG: null as unknown,
}));

vi.mock('../../../src/main/scheduler', () => {
  class MockTaskDAG {
    id: string;
    tasks: Map<string, unknown> = new Map();
    config: unknown;
    constructor(id: string, _name: string, config: unknown) {
      this.id = id;
      this.config = config;
    }
    addAgentTask(taskId: string, spec: unknown, meta: unknown): void {
      this.tasks.set(taskId, { id: taskId, spec, meta });
    }
    validate(): { valid: boolean; errors: string[] } {
      return { valid: true, errors: [] };
    }
    getAllTasks(): unknown[] {
      return Array.from(this.tasks.values());
    }
  }
  return {
    TaskDAG: MockTaskDAG,
    getDAGScheduler: () => ({
      execute: (dag: unknown, _ctx: unknown) => {
        schedulerState.capturedDAG = dag;
        return schedulerState.executeMock(dag);
      },
    }),
  };
});

import {
  ParallelAgentCoordinator,
  type AgentTask,
  type CoordinatorEvent,
} from '../../../src/main/agent/parallelAgentCoordinator';

function makeFakeContext() {
  return {
    modelConfig: { provider: 'mock', model: 'mock-model' } as never,
    toolResolver: {} as never,
    toolContext: {
      currentToolCallId: 'call-1',
      hookManager: undefined,
    } as never,
  };
}

function makeTask(
  id: string,
  overrides: Partial<AgentTask> = {}
): AgentTask {
  return {
    id,
    role: 'coder',
    task: `task description for ${id}`,
    tools: ['Read'],
    ...overrides,
  };
}

describe('ParallelAgentCoordinator', () => {
  let coordinator: ParallelAgentCoordinator;

  beforeEach(() => {
    executorState.executeMock.mockReset();
    schedulerState.executeMock.mockReset();
    schedulerState.capturedDAG = null;

    coordinator = new ParallelAgentCoordinator({
      maxParallelTasks: 4,
      taskTimeout: 5000,
      enableSharedContext: true,
      aggregateResults: false, // 禁用聚合以保留原始顺序便于断言
    });
    coordinator.initialize(makeFakeContext());

    // Default executor: success with echoed task id
    executorState.executeMock.mockImplementation(
      async (_task: string, spec: { name: string }) => ({
        success: true,
        output: `ok:${spec.name}`,
        iterations: 1,
        toolsUsed: ['Read'],
        cost: 0,
      })
    );
  });

  // ==========================================================================
  // 初始化
  // ==========================================================================

  describe('初始化', () => {
    it('未调用 initialize 时 executeParallel 抛错', async () => {
      const fresh = new ParallelAgentCoordinator();
      await expect(fresh.executeParallel([makeTask('a')])).rejects.toThrow(
        /not initialized/i
      );
    });

    it('updateConfig 合并进现有配置', () => {
      coordinator.updateConfig({ maxParallelTasks: 2 });
      expect(coordinator.getConfig().maxParallelTasks).toBe(2);
      // 原有字段保留
      expect(coordinator.getConfig().enableSharedContext).toBe(true);
    });
  });

  // ==========================================================================
  // executeParallel 依赖调度
  // ==========================================================================

  describe('executeParallel 依赖调度', () => {
    it('无依赖的任务在一组内执行', async () => {
      const result = await coordinator.executeParallel([
        makeTask('a', { role: 'coder' }),
        makeTask('b', { role: 'tester' }),
      ]);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.parallelism).toBe(2);
      expect(executorState.executeMock).toHaveBeenCalledTimes(2);
    });

    it('dependsOn 的任务排在依赖完成之后', async () => {
      const order: string[] = [];
      executorState.executeMock.mockImplementation(
        async (_t: string, spec: { name: string }) => {
          order.push(spec.name);
          return {
            success: true,
            output: `ok:${spec.name}`,
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        }
      );

      await coordinator.executeParallel([
        makeTask('child', { role: 'reviewer', dependsOn: ['parent'] }),
        makeTask('parent', { role: 'coder' }),
      ]);

      const parentIdx = order.indexOf('coder');
      const childIdx = order.indexOf('reviewer');
      expect(parentIdx).toBeGreaterThanOrEqual(0);
      expect(childIdx).toBeGreaterThan(parentIdx);
    });

    it('同组内按 priority 降序排序', async () => {
      const order: string[] = [];
      executorState.executeMock.mockImplementation(
        async (_t: string, spec: { name: string }) => {
          order.push(spec.name);
          return {
            success: true,
            output: '',
            iterations: 0,
            toolsUsed: [],
            cost: 0,
          };
        }
      );

      // maxParallelTasks=1 保证串行执行
      coordinator.updateConfig({ maxParallelTasks: 1 });

      await coordinator.executeParallel([
        makeTask('low', { role: 'tester', priority: 1 }),
        makeTask('hi', { role: 'architect', priority: 10 }),
        makeTask('mid', { role: 'coder', priority: 5 }),
      ]);

      expect(order).toEqual(['architect', 'coder', 'tester']);
    });

    it('任务失败时进入 errors 且 success=false', async () => {
      executorState.executeMock.mockImplementation(
        async (_t: string, spec: { name: string }) => {
          if (spec.name === 'tester') {
            return {
              success: false,
              output: '',
              error: 'assertion failed',
              iterations: 2,
              toolsUsed: [],
              cost: 0,
            };
          }
          return {
            success: true,
            output: 'ok',
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        }
      );

      const result = await coordinator.executeParallel([
        makeTask('a', { role: 'coder' }),
        makeTask('b', { role: 'tester' }),
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].taskId).toBe('b');
      expect(result.errors[0].error).toBe('assertion failed');
    });

  });

  // ==========================================================================
  // SharedContext
  // ==========================================================================

  describe('SharedContext', () => {
    it('output 含 file: 路径时写入 files map', async () => {
      executorState.executeMock.mockResolvedValueOnce({
        success: true,
        output: 'Found issue in file: src/auth.ts',
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      });

      await coordinator.executeParallel([makeTask('a', { role: 'coder' })]);

      const ctx = coordinator.getSharedContext();
      expect(ctx.files.size).toBeGreaterThan(0);
      // 关键词 "found" 也会导致 findings 写入
      expect(ctx.findings.size).toBeGreaterThan(0);
    });

    it('shareDiscovery 发布 discovery 事件', () => {
      const events: CoordinatorEvent[] = [];
      coordinator.on('discovery', (e) => events.push(e as CoordinatorEvent));

      coordinator.shareDiscovery('bug-42', { severity: 'high' });

      expect(events).toHaveLength(1);
      expect(coordinator.getSharedContext().findings.get('bug-42')).toEqual({
        severity: 'high',
      });
    });

    it('exportSharedContext 序列化所有 Map', () => {
      coordinator.shareDiscovery('k1', 'v1');
      const exported = coordinator.exportSharedContext();
      expect(exported.findings).toEqual({ k1: 'v1' });
      expect(exported.files).toEqual({});
      expect(exported.errors).toEqual([]);
    });

    it('importSharedContext 合并到现有 context', () => {
      coordinator.importSharedContext({
        findings: { a: 1 },
        files: { 'x.ts': 'coder' },
        errors: ['err1'],
      });
      const ctx = coordinator.getSharedContext();
      expect(ctx.findings.get('a')).toBe(1);
      expect(ctx.files.get('x.ts')).toBe('coder');
      expect(ctx.errors).toContain('err1');
    });

    it('clearSharedContext 重置所有字段', () => {
      coordinator.shareDiscovery('x', 1);
      coordinator.clearSharedContext();
      const ctx = coordinator.getSharedContext();
      expect(ctx.findings.size).toBe(0);
    });
  });

  // ==========================================================================
  // 事件发射
  // ==========================================================================

  describe('事件发射', () => {
    it('正常流程依次发 task:start / task:complete / all:complete', async () => {
      const seen: string[] = [];
      coordinator.on('task:start', () => seen.push('start'));
      coordinator.on('task:complete', () => seen.push('complete'));
      coordinator.on('all:complete', () => seen.push('all'));

      await coordinator.executeParallel([makeTask('a', { role: 'coder' })]);

      expect(seen).toEqual(['start', 'complete', 'all']);
    });

  });

  // ==========================================================================
  // retryTask / abortTask
  // ==========================================================================

  describe('retryTask', () => {
    it('未知 taskId 抛错', async () => {
      await expect(coordinator.retryTask('missing')).rejects.toThrow(
        /Task definition not found/
      );
    });

    it('已执行过的任务可以被重试并再次调用 executor', async () => {
      await coordinator.executeParallel([makeTask('a', { role: 'coder' })]);
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);

      const retried = await coordinator.retryTask('a');
      expect(retried.success).toBe(true);
      expect(executorState.executeMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('abortTask', () => {
    it('未注册 taskId 返回 false', () => {
      expect(coordinator.abortTask('missing')).toBe(false);
    });
  });

  // ==========================================================================
  // executeWithDAG
  // ==========================================================================

  describe('executeWithDAG', () => {
    it('未初始化抛错', async () => {
      const fresh = new ParallelAgentCoordinator();
      await expect(fresh.executeWithDAG([makeTask('a')])).rejects.toThrow(
        /not initialized/i
      );
    });

    it('交给 scheduler 执行并转换结果', async () => {
      schedulerState.executeMock.mockResolvedValueOnce({
        success: true,
        totalDuration: 1234,
        maxParallelism: 2,
        dag: {
          getAllTasks: () => [
            {
              id: 'a',
              status: 'completed',
              name: 'coder',
              config: { type: 'agent', role: 'coder' },
              output: { text: 'done', toolsUsed: ['Read'], iterations: 3 },
              metadata: { startedAt: 1, completedAt: 2, duration: 1 },
            },
          ],
        },
      });

      const result = await coordinator.executeWithDAG([
        makeTask('a', { role: 'coder' }),
      ]);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].taskId).toBe('a');
      expect(result.totalDuration).toBe(1234);
      expect(schedulerState.capturedDAG).not.toBeNull();
    });

    it('scheduler 返回失败节点时收集 errors', async () => {
      schedulerState.executeMock.mockResolvedValueOnce({
        success: false,
        totalDuration: 50,
        maxParallelism: 1,
        dag: {
          getAllTasks: () => [
            {
              id: 'a',
              status: 'failed',
              name: 'coder',
              config: { type: 'agent', role: 'coder' },
              failure: { message: 'nope' },
              metadata: {},
            },
          ],
        },
      });

      const result = await coordinator.executeWithDAG([
        makeTask('a', { role: 'coder' }),
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe('nope');
    });
  });

  // ==========================================================================
  // reset
  // ==========================================================================

  describe('reset', () => {
    it('清空 completed tasks / shared context / listeners', async () => {
      coordinator.on('task:complete', vi.fn());
      await coordinator.executeParallel([makeTask('a', { role: 'coder' })]);
      coordinator.shareDiscovery('k', 'v');

      coordinator.reset();

      expect(coordinator.getCompletedTasks()).toHaveLength(0);
      expect(coordinator.getSharedContext().findings.size).toBe(0);
      expect(coordinator.listenerCount('task:complete')).toBe(0);
    });
  });
});
