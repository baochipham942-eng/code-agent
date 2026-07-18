// ============================================================================
// ParallelAgentCoordinator Tests
// 覆盖依赖排序、SharedContext 合并、事件发射、失败传播、retryTask
// mock getSubagentExecutor 返回假 result
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
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

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
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

vi.mock('../../../src/host/scheduler', () => {
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
    createRunDAGScheduler: () => ({
      execute: (dag: unknown, _ctx: unknown) => {
        schedulerState.capturedDAG = dag;
        return schedulerState.executeMock(dag);
      },
      setSubagentExecutor: vi.fn(),
    }),
  };
});

import {
  AgentFailureCode,
} from '../../../src/shared/contract/agentFailure';
import {
  AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
  type AgentTeamCheckpointState,
  type AgentTeamDurableController,
  type AgentTeamMailboxMessage,
} from '../../../src/host/agent/agentTeamDurableTypes';
import {
  initParallelAgentCoordinator,
  ParallelAgentCoordinator,
  ParallelAgentCoordinatorRegistry,
  resetParallelAgentCoordinators,
  type AgentTask,
  type CoordinatorEvent,
} from '../../../src/host/agent/parallelAgentCoordinator';
import {
  createScopedSwarmAgentId,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { aggregateTeamResults } from '../../../src/host/agent/resultAggregator';

function makeFakeContext() {
  return {
    // 注意：executionContext 不在这里整体 as never——测试里多处要
    // `{ ...makeFakeContext().executionContext, ... }` 展开覆盖字段，
    // 源头是 never 会导致 spread 报 TS2698。改成在真正传给
    // coordinator.initialize() 的调用点按需 as never（mock 只补了子集字段，
    // 达不到真实 SubagentExecutionContext 的完整形状）。
    executionContext: {
      sessionId: 'test-session',
      cwd: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      resolver: { getDefinition: vi.fn() },
      permission: { request: async () => true },
      events: { emit: vi.fn() },
      abortSignal: new AbortController().signal,
      currentToolCallId: 'call-1',
    },
    subagentExecutor: {
      execute: executorState.executeMock,
    },
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

function makeFakeDurableController(scope: SwarmRunScope): AgentTeamDurableController {
  const persistedMessages: AgentTeamMailboxMessage[] = [];
  const state: AgentTeamCheckpointState = {
    schemaVersion: AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
    kind: 'agent_team',
    teamId: `team:${scope.runId}`,
    treeId: scope.treeId,
    scope,
    parentRunId: 'parent-run',
    taskGraph: [],
    mailbox: {
      nextSeq: 1,
      committedCursor: 0,
      pending: [],
      consumedMessageIds: [],
    },
    findings: {},
    decisions: {},
    errors: [],
    completedNodeResultRefs: {},
    runningChildRefs: [],
    pendingApprovalRefs: [],
    worktreeRefs: {},
    artifactRefs: {},
    cancelled: false,
    updatedAt: 1,
  };

  return {
    scope,
    ownerEpoch: 1,
    getState: () => state,
    checkpoint: vi.fn(async () => undefined),
    markApprovalWaiting: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => undefined),
    markNodeDispatched: vi.fn(async () => undefined),
    markNodeTerminal: vi.fn(async () => undefined),
    enqueueMessage: vi.fn(async (agentId, body, from = 'user', type = 'text', now = Date.now()) => {
      const persisted: AgentTeamMailboxMessage = {
        id: `message-${persistedMessages.length + 1}`,
        seq: persistedMessages.length + 1,
        treeId: scope.treeId,
        agentId,
        from,
        type,
        body,
        createdAt: now,
      };
      persistedMessages.push(persisted);
      return persisted;
    }),
    consumeMessages: vi.fn(async (agentId) => {
      const consumed = persistedMessages.filter((message) => message.agentId === agentId);
      for (const message of consumed) {
        persistedMessages.splice(persistedMessages.indexOf(message), 1);
      }
      return consumed;
    }),
    cancel: vi.fn(async () => undefined),
    terminal: vi.fn(async () => undefined),
  };
}

describe('ParallelAgentCoordinator', () => {
  let coordinator: ParallelAgentCoordinator;

  beforeEach(() => {
    resetSpawnGuard();
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
      async (request: { config: { name: string } }) => ({
        success: true,
        output: `ok:${request.config.name}`,
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

    it('uses an injected subagent executor port instead of the singleton executor', async () => {
      const injectedExecute = vi.fn(async (request: { config: { name: string } }) => ({
        success: true,
        output: `injected:${request.config.name}`,
        iterations: 1,
        toolsUsed: ['Read'],
      }));
      const injected = new ParallelAgentCoordinator({
        maxParallelTasks: 1,
        taskTimeout: 5000,
        aggregateResults: false,
      });
      injected.initialize({
        ...makeFakeContext(),
        subagentExecutor: { execute: injectedExecute },
      });

      const result = await injected.executeParallel([makeTask('injected-task')]);

      expect(result.success).toBe(true);
      expect(result.results[0].output).toBe('injected:coder');
      expect(injectedExecute).toHaveBeenCalledTimes(1);
      expect(executorState.executeMock).not.toHaveBeenCalled();
    });

    it('子 agent 不标拓扑（parallel 是 swarm 宿主，递归 spawn 是现役特性——2026-07-13 拍板留 main）', async () => {
      const topologies: Array<string | undefined> = [];
      executorState.executeMock.mockImplementation(
        async (request: { config: { name: string }; context?: { executionTopology?: string } }) => {
          topologies.push(request.context?.executionTopology);
          return {
            success: true,
            output: `ok:${request.config.name}`,
            iterations: 1,
            toolsUsed: ['Read'],
            cost: 0,
          };
        }
      );

      await coordinator.executeParallel([makeTask('topo-task')]);

      expect(topologies).toEqual([undefined]);
    });

    it('locks scoped dependencies after first initialization', () => {
      const scope: SwarmRunScope = {
        sessionId: 'session-scoped',
        runId: 'run-a',
        treeId: 'tree-a',
      };
      const scoped = new ParallelAgentCoordinator({}, scope);
      const firstExecutor = { execute: vi.fn() };
      scoped.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scope.sessionId } as never,
        subagentExecutor: firstExecutor as never,
        scope,
      });
      expect(scoped.isInitialized()).toBe(true);

      expect(() => scoped.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scope.sessionId } as never,
        subagentExecutor: { execute: vi.fn() } as never,
        scope,
      })).toThrow(/already initialized/i);
      expect(() => scoped.setSubagentExecutor({ execute: vi.fn() } as never)).toThrow(
        /cannot be replaced/i,
      );
    });

    it('keeps the legacy registry bucket usable with an ordinary session context', () => {
      const legacy = initParallelAgentCoordinator();
      expect(() => legacy.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: 'legacy-session' } as never,
      })).not.toThrow();
      expect(legacy.isInitialized()).toBe(true);
      resetParallelAgentCoordinators();
    });

    it('keeps two same-role Team scopes in distinct coordinator containers', () => {
      const registry = new ParallelAgentCoordinatorRegistry();
      const scopeA: SwarmRunScope = {
        sessionId: 'shared-session',
        runId: 'run-a',
        treeId: 'same-tree-label',
      };
      const scopeB: SwarmRunScope = {
        sessionId: 'shared-session',
        runId: 'run-b',
        treeId: 'same-tree-label',
      };
      const coordinatorA = registry.getOrCreate(scopeA);
      const coordinatorB = registry.getOrCreate(scopeB);

      coordinatorA.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scopeA.sessionId } as never,
        scope: scopeA,
      });
      coordinatorB.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scopeB.sessionId } as never,
        scope: scopeB,
      });
      const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
      const agentB = createScopedSwarmAgentId(scopeB, 'agent_coder_0');
      coordinatorA.shareDiscovery('same-role', agentA);
      coordinatorB.shareDiscovery('same-role', agentB);

      expect(coordinatorA).not.toBe(coordinatorB);
      expect(registry.size()).toBe(2);
      expect(coordinatorA.exportSharedContext().findings['same-role']).toBe(agentA);
      expect(coordinatorB.exportSharedContext().findings['same-role']).toBe(agentB);
    });

    it('cancels one running same-role Team while the concurrent Team keeps running', async () => {
      const scopeA: SwarmRunScope = {
        sessionId: 'session-a',
        runId: 'run-a',
        treeId: 'tree-a',
      };
      const scopeB: SwarmRunScope = {
        sessionId: scopeA.sessionId,
        runId: 'run-b',
        treeId: scopeA.treeId,
      };
      const registry = new ParallelAgentCoordinatorRegistry();
      const coordinatorA = registry.getOrCreate(scopeA, {
        maxParallelTasks: 1,
        taskTimeout: 5_000,
        aggregateResults: false,
      });
      const coordinatorB = registry.getOrCreate(scopeB, {
        maxParallelTasks: 1,
        taskTimeout: 5_000,
        aggregateResults: false,
      });
      let signalA: AbortSignal | undefined;
      let signalB: AbortSignal | undefined;
      let resolveB!: (value: {
        success: boolean;
        output: string;
        iterations: number;
        toolsUsed: string[];
        cost: number;
      }) => void;
      const executorA = {
        execute: vi.fn((request: { context: { abortSignal: AbortSignal } }) => {
          signalA = request.context.abortSignal;
          return new Promise((resolve) => {
            request.context.abortSignal.addEventListener('abort', () => resolve({
              success: false,
              output: '',
              error: 'cancelled-a',
              iterations: 0,
              toolsUsed: [],
              cost: 0,
            }), { once: true });
          });
        }),
      };
      const executorB = {
        execute: vi.fn((request: { context: { abortSignal: AbortSignal } }) => {
          signalB = request.context.abortSignal;
          return new Promise((resolve) => { resolveB = resolve; });
        }),
      };
      coordinatorA.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scopeA.sessionId, swarmRunScope: scopeA } as never,
        subagentExecutor: executorA as never,
        scope: scopeA,
      });
      coordinatorB.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scopeB.sessionId, swarmRunScope: scopeB } as never,
        subagentExecutor: executorB as never,
        scope: scopeB,
      });
      vi.spyOn(coordinatorA, 'persistCheckpoint').mockResolvedValue(undefined);
      vi.spyOn(coordinatorB, 'persistCheckpoint').mockResolvedValue(undefined);
      const agentA = createScopedSwarmAgentId(scopeA, 'agent_reviewer_0');
      const agentB = createScopedSwarmAgentId(scopeB, 'agent_reviewer_0');

      const runA = coordinatorA.executeParallel([makeTask(agentA, { role: 'reviewer' })]);
      const runB = coordinatorB.executeParallel([makeTask(agentB, { role: 'reviewer' })]);
      await vi.waitFor(() => {
        expect(signalA).toBeDefined();
        expect(signalB).toBeDefined();
      });
      expect(getSpawnGuard().get(agentA, scopeA)?.status).toBe('running');
      expect(getSpawnGuard().get(agentB, scopeB)?.status).toBe('running');

      expect(getSpawnGuard().cancelRun(scopeA, 'user-cancel')).toBe(1);
      expect(registry.abortRun(scopeA, 'user-cancel')).toBe(true);
      const resultA = await runA;

      expect(signalA?.aborted).toBe(true);
      expect(signalB?.aborted).toBe(false);
      expect(resultA.results[0]).toMatchObject({ taskId: agentA, cancelled: true });
      expect(coordinatorB.isExecuting()).toBe(true);
      expect(getSpawnGuard().get(agentB, scopeB)?.status).toBe('running');

      resolveB({ success: true, output: 'completed-b', iterations: 1, toolsUsed: [], cost: 0 });
      const resultB = await runB;
      expect(resultB.success).toBe(true);
      expect(resultB.results[0]).toMatchObject({ taskId: agentB, output: 'completed-b' });
      expect(signalB?.aborted).toBe(false);
    });

    it('rejects binding one session/run identity to a second tree', () => {
      const registry = new ParallelAgentCoordinatorRegistry();
      registry.getOrCreate({
        sessionId: 'session-a',
        runId: 'run-a',
        treeId: 'tree-a',
      });

      expect(() => registry.getOrCreate({
        sessionId: 'session-a',
        runId: 'run-a',
        treeId: 'tree-b',
      })).toThrow(/already bound to tree tree-a/i);
      expect(() => registry.replace({
        sessionId: 'session-a',
        runId: 'run-a',
        treeId: 'tree-b',
      })).toThrow(/already bound to tree tree-a/i);
      expect(registry.size()).toBe(1);
    });

    it('moves terminal runs to an immutable lightweight snapshot and releases the live coordinator', () => {
      const registry = new ParallelAgentCoordinatorRegistry();
      const scope: SwarmRunScope = {
        sessionId: 'terminal-session',
        runId: 'terminal-run',
        treeId: 'terminal-tree',
      };
      const live = registry.getOrCreate(scope);
      live.initialize({
        ...makeFakeContext(),
        executionContext: { ...makeFakeContext().executionContext, sessionId: scope.sessionId, swarmRunScope: scope } as never,
        scope,
      });

      const terminal = registry.finalize(scope, 'completed', 1234);

      expect(registry.get(scope)).toBeUndefined();
      expect(registry.getByRun(scope)).toBeUndefined();
      expect(registry.size()).toBe(0);
      expect(registry.getCompleted(scope)).toEqual({
        scope,
        status: 'completed',
        completedAt: 1234,
        tasks: [],
      });
      expect(terminal).toEqual(registry.getCompleted(scope));
      expect(Object.isFrozen(terminal)).toBe(true);
      expect(Object.isFrozen(terminal?.scope)).toBe(true);
      expect(Object.isFrozen(terminal?.tasks)).toBe(true);
      expect(() => registry.getOrCreate(scope)).toThrow(/already terminal/i);
      expect(() => registry.getOrCreate({ ...scope, treeId: 'foreign-tree' }))
        .toThrow(/already terminal on tree terminal-tree/i);
    });
  });

  // ==========================================================================
  // executeParallel 依赖调度
  // ==========================================================================

  describe('executeParallel 依赖调度', () => {
    it('fails fast on reentrant execution instead of clearing the active run state', async () => {
      let resolveFirst!: (result: {
        success: boolean;
        output: string;
        iterations: number;
        toolsUsed: string[];
        cost: number;
      }) => void;
      executorState.executeMock.mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }));

      const first = coordinator.executeParallel([makeTask('same-role-a')]);
      await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
      await expect(
        coordinator.executeParallel([makeTask('same-role-b')]),
      ).rejects.toThrow(/not reentrant/i);

      resolveFirst({
        success: true,
        output: 'done',
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      });
      await expect(first).resolves.toMatchObject({ success: true });
      expect(coordinator.isExecuting()).toBe(false);
    });

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
        async (request: { config: { name: string } }) => {
          order.push(request.config.name);
          return {
            success: true,
            output: `ok:${request.config.name}`,
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
        async (request: { config: { name: string } }) => {
          order.push(request.config.name);
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
        async (request: { config: { name: string } }) => {
          if (request.config.name === 'tester') {
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
      expect(result.results.find((entry) => entry.taskId === 'b')?.failureCode).toBe(AgentFailureCode.Unknown);
    });

    it('上游失败时 downstream 标记 blocked 且不会启动', async () => {
      executorState.executeMock.mockImplementation(
        async (request: { config: { name: string } }) => {
          if (request.config.name === 'coder') {
            return {
              success: false,
              output: '',
              error: 'compile failed',
              iterations: 1,
              toolsUsed: [],
              cost: 0,
            };
          }
          return {
            success: true,
            output: 'should not run',
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        }
      );

      const result = await coordinator.executeParallel([
        makeTask('parent', { role: 'coder' }),
        makeTask('child', { role: 'tester', dependsOn: ['parent'] }),
      ]);

      expect(result.success).toBe(false);
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);
      const child = result.results.find((entry) => entry.taskId === 'child');
      expect(child?.blocked).toBe(true);
      expect(child?.error).toContain('Blocked by failed dependencies: parent');
      expect(child?.failureCode).toBe(AgentFailureCode.DependencyFailed);
    });

    it('aggregation 按总任务数计算 successRate，失败 agent 也进入结果结构', async () => {
      executorState.executeMock.mockImplementation(
        async (request: { config: { name: string } }) => ({
          success: request.config.name === 'coder',
          output: request.config.name === 'coder' ? 'ok' : '',
          error: request.config.name === 'coder' ? undefined : 'test failed',
          iterations: 1,
          toolsUsed: [],
          cost: 0,
        })
      );

      const result = await coordinator.executeParallel([
        makeTask('a', { role: 'coder' }),
        makeTask('b', { role: 'tester' }),
      ]);
      const aggregation = aggregateTeamResults(result.results, result.totalDuration);

      expect(result.results).toHaveLength(2);
      expect(aggregation.agentResults).toHaveLength(2);
      expect(aggregation.successRate).toBe(0.5);
    });

    it('direct user messages queued on the parallel executor inbox can be drained by the executor', async () => {
      let release!: () => void;
      let drainMessages: (() => Promise<Array<{ payload: string }>>) | undefined;

      executorState.executeMock.mockImplementation(
        async (request: { context: { messageDrain?: () => Promise<Array<{ payload: string }>> } }) => {
          drainMessages = request.context.messageDrain;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            success: true,
            output: 'ok',
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        }
      );

      const run = coordinator.executeParallel([makeTask('a', { role: 'coder' })]);
      await vi.waitFor(() => expect(drainMessages).toBeTypeOf('function'));

      await expect(coordinator.sendMessage('a', 'hello from user')).resolves.toBe(true);
      expect((await drainMessages?.())?.map((message) => message.payload)).toEqual(['hello from user']);

      release();
      await run;
    });

    it('durable enqueue failure reports false and leaves the executor inbox empty', async () => {
      const scope: SwarmRunScope = {
        sessionId: 'durable-enqueue-session',
        runId: 'durable-enqueue-run',
        treeId: 'durable-enqueue-tree',
      };
      const durableController = makeFakeDurableController(scope);
      const agentId = createScopedSwarmAgentId(scope, 'agent-coder');
      vi.mocked(durableController.enqueueMessage).mockRejectedValueOnce(new Error('checkpoint failed'));
      coordinator = new ParallelAgentCoordinator({
        maxParallelTasks: 1,
        taskTimeout: 5000,
        aggregateResults: false,
      }, scope);
      coordinator.initialize({
        ...makeFakeContext(),
        executionContext: {
          ...makeFakeContext().executionContext,
          sessionId: scope.sessionId,
          swarmRunScope: scope,
        } as never,
        scope,
        durableController,
      });

      let release!: () => void;
      let drainMessages: (() => Promise<Array<{ payload: string }>>) | undefined;
      executorState.executeMock.mockImplementation(
        async (request: { context: { messageDrain?: () => Promise<Array<{ payload: string }>> } }) => {
          drainMessages = request.context.messageDrain;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            success: true,
            output: 'ok',
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        },
      );

      const run = coordinator.executeParallel([makeTask(agentId, { role: 'coder' })]);
      await vi.waitFor(() => expect(drainMessages).toBeTypeOf('function'));

      await expect(coordinator.sendMessage(agentId, 'unpersisted message')).resolves.toBe(false);
      expect(await drainMessages?.()).toEqual([]);

      release();
      await run;
    });

    it('durable messages are consumed only after the drained batch is acknowledged', async () => {
      const scope: SwarmRunScope = {
        sessionId: 'durable-ack-session',
        runId: 'durable-ack-run',
        treeId: 'durable-ack-tree',
      };
      const durableController = makeFakeDurableController(scope);
      const agentId = createScopedSwarmAgentId(scope, 'agent-coder');
      coordinator = new ParallelAgentCoordinator({
        maxParallelTasks: 1,
        taskTimeout: 5000,
        aggregateResults: false,
      }, scope);
      coordinator.initialize({
        ...makeFakeContext(),
        executionContext: {
          ...makeFakeContext().executionContext,
          sessionId: scope.sessionId,
          swarmRunScope: scope,
        } as never,
        scope,
        durableController,
      });

      let release!: () => void;
      let drainMessages: (() => Promise<Array<{ payload: string }>>) | undefined;
      let ackMessageDrain: (() => void | Promise<void>) | undefined;
      executorState.executeMock.mockImplementation(
        async (request: {
          context: {
            messageDrain?: () => Promise<Array<{ payload: string }>>;
            ackMessageDrain?: () => void | Promise<void>;
          };
        }) => {
          drainMessages = request.context.messageDrain;
          ackMessageDrain = request.context.ackMessageDrain;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            success: true,
            output: 'ok',
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        },
      );

      const run = coordinator.executeParallel([makeTask(agentId, { role: 'coder' })]);
      await vi.waitFor(() => expect(ackMessageDrain).toBeTypeOf('function'));

      await expect(coordinator.sendMessage(agentId, 'durable message')).resolves.toBe(true);
      expect((await drainMessages?.())?.map((message) => message.payload)).toEqual(['durable message']);
      expect(durableController.consumeMessages).not.toHaveBeenCalled();

      await ackMessageDrain?.();
      expect(durableController.consumeMessages).toHaveBeenCalledTimes(1);
      expect(durableController.consumeMessages).toHaveBeenCalledWith(agentId);

      release();
      await run;
    });

    it('run-level cancel aborts running task and prevents pending task from starting', async () => {
      coordinator.updateConfig({ maxParallelTasks: 1 });
      const started: string[] = [];

      executorState.executeMock.mockImplementation(
        async (request: { config: { name: string }; context: { abortSignal?: AbortSignal } }) => {
          started.push(request.config.name);
          await new Promise<void>((resolve) => {
            request.context.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            success: false,
            output: '',
            error: 'cancelled',
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        }
      );

      const run = coordinator.executeParallel([
        makeTask('a', { role: 'coder' }),
        makeTask('b', { role: 'tester' }),
      ]);

      await vi.waitFor(() => expect(started).toEqual(['coder']));
      coordinator.abortAllRunning('run_cancelled');
      const result = await run;

      expect(started).toEqual(['coder']);
      const pending = result.results.find((entry) => entry.taskId === 'b');
      expect(pending?.cancelled).toBe(true);
      expect(pending?.error).toContain('Cancelled before start');
      expect(pending?.failureCode).toBe(AgentFailureCode.CancelledByUser);
    });

    it('通过 SpawnGuard tree quota 排队执行，不丢弃超额 ready task', async () => {
      resetSpawnGuard();
      getSpawnGuard({ maxAgents: 2 });
      coordinator = new ParallelAgentCoordinator({
        maxParallelTasks: 4,
        taskTimeout: 5000,
        enableSharedContext: false,
        aggregateResults: false,
      });
      coordinator.initialize({
        ...makeFakeContext(),
        executionContext: {
          ...makeFakeContext().executionContext,
          sessionId: 'root-session',
          currentToolCallId: 'call-1',
          spawnTreeId: 'root-session',
        } as never,
      });

      let active = 0;
      let peak = 0;
      executorState.executeMock.mockImplementation(
        async (request: { config: { name: string } }) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active--;
          return {
            success: true,
            output: `ok:${request.config.name}`,
            iterations: 1,
            toolsUsed: [],
            cost: 0,
          };
        },
      );

      const result = await coordinator.executeParallel([
        makeTask('a', { role: 'coder' }),
        makeTask('b', { role: 'tester' }),
        makeTask('c', { role: 'reviewer' }),
        makeTask('d', { role: 'architect' }),
      ]);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(4);
      expect(executorState.executeMock).toHaveBeenCalledTimes(4);
      expect(peak).toBeLessThanOrEqual(2);
      expect(getSpawnGuard().getReservedCount('root-session')).toBe(0);
    });

    it('slot handoff 后立即取消 run，executor 不启动且同 tree 的另一 run 可继续', async () => {
      resetSpawnGuard();
      const guard = getSpawnGuard({ maxAgents: 1 });
      const scopeA: SwarmRunScope = {
        sessionId: 'shared-session',
        runId: 'run-a',
        treeId: 'shared-tree',
      };
      const scopeB: SwarmRunScope = {
        sessionId: scopeA.sessionId,
        runId: 'run-b',
        treeId: scopeA.treeId,
      };
      const registry = new ParallelAgentCoordinatorRegistry();
      const queuedCoordinator = registry.getOrCreate(scopeA, {
        maxParallelTasks: 1,
        taskTimeout: 5_000,
        aggregateResults: false,
      });
      queuedCoordinator.initialize({
        ...makeFakeContext(),
        executionContext: {
          ...makeFakeContext().executionContext,
          sessionId: scopeA.sessionId,
          currentToolCallId: 'call-run-a',
          spawnTreeId: scopeA.treeId,
          swarmRunScope: scopeA,
        } as never,
        scope: scopeA,
      });
      vi.spyOn(queuedCoordinator, 'persistCheckpoint').mockResolvedValue(undefined);
      const taskStarts = vi.fn();
      queuedCoordinator.on('task:start', taskStarts);
      const holder = await guard.acquireSlot({ scope: scopeB, timeoutMs: 1_000 });
      const queuedAgentId = createScopedSwarmAgentId(scopeA, 'agent_coder_0');

      const runA = queuedCoordinator.executeParallel([
        makeTask(queuedAgentId, { role: 'coder' }),
      ]);
      await Promise.resolve();
      expect(executorState.executeMock).not.toHaveBeenCalled();
      expect(guard.getReservedCount(scopeA)).toBe(1);

      // Deliberately grant the queued lease first. Cancellation happens before
      // its await continuation, so the coordinator post-lease check must stop it.
      holder.release();
      expect(guard.cancelRun(scopeA, 'run_cancelled')).toBe(0);
      expect(registry.abortRun(scopeA, 'run_cancelled')).toBe(true);

      const resultA = await runA;
      expect(executorState.executeMock).not.toHaveBeenCalled();
      expect(taskStarts).not.toHaveBeenCalled();
      expect(resultA.success).toBe(false);
      expect(resultA.results[0]).toMatchObject({
        taskId: queuedAgentId,
        cancelled: true,
        failureCode: AgentFailureCode.CancelledByUser,
      });

      const runBLease = await guard.acquireSlot({ scope: scopeB, timeoutMs: 1_000 });
      runBLease.release();
      expect(guard.getReservedCount(scopeB)).toBe(0);
    });

    it('slot handoff 后 parent signal abort，executor 仍保持零启动', async () => {
      resetSpawnGuard();
      const guard = getSpawnGuard({ maxAgents: 1 });
      const scope: SwarmRunScope = {
        sessionId: 'parent-session',
        runId: 'child-run',
        treeId: 'shared-tree',
      };
      const holderScope: SwarmRunScope = {
        sessionId: scope.sessionId,
        runId: 'holder-run',
        treeId: scope.treeId,
      };
      const parentAbortController = new AbortController();
      const scopedCoordinator = new ParallelAgentCoordinator({
        maxParallelTasks: 1,
        taskTimeout: 5_000,
        aggregateResults: false,
      }, scope);
      scopedCoordinator.initialize({
        ...makeFakeContext(),
        executionContext: {
          ...makeFakeContext().executionContext,
          sessionId: scope.sessionId,
          currentToolCallId: 'call-child-run',
          spawnTreeId: scope.treeId,
          swarmRunScope: scope,
          abortSignal: parentAbortController.signal,
        } as never,
        scope,
      });
      vi.spyOn(scopedCoordinator, 'persistCheckpoint').mockResolvedValue(undefined);
      const taskStarts = vi.fn();
      scopedCoordinator.on('task:start', taskStarts);
      const holder = await guard.acquireSlot({ scope: holderScope, timeoutMs: 1_000 });
      const childAgentId = createScopedSwarmAgentId(scope, 'agent_coder_0');

      const childRun = scopedCoordinator.executeParallel([
        makeTask(childAgentId, { role: 'coder' }),
      ]);
      await Promise.resolve();
      expect(executorState.executeMock).not.toHaveBeenCalled();

      holder.release();
      parentAbortController.abort('parent_cancelled');

      const result = await childRun;
      expect(executorState.executeMock).not.toHaveBeenCalled();
      expect(taskStarts).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({
        taskId: childAgentId,
        cancelled: true,
      });
      expect(result.results[0].error).toContain('parent_cancelled');
      expect(guard.getReservedCount(scope)).toBe(0);
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
  // Draft 新鲜度（swarm 护栏 P1-2 #5）—— 版本戳 + isStale
  // ==========================================================================

  describe('Draft 新鲜度', () => {
    it('shareDiscovery 写入版本戳（lastUpdated）', () => {
      coordinator.shareDiscovery('k', 'v', 1000);
      const ctx = coordinator.getSharedContext();
      expect(ctx.lastUpdated.get('k')).toBe(1000);
      expect(coordinator.getLastUpdated('k')).toBe(1000);
    });

    it('isStale：新鲜数据返回 false，超龄数据返回 true', () => {
      coordinator.shareDiscovery('k', 'v', 1000);
      // now=1500，maxAge=1000 → 龄 500ms，未超
      expect(coordinator.isStale('k', 1000, 1500)).toBe(false);
      // now=2500，maxAge=1000 → 龄 1500ms，超龄
      expect(coordinator.isStale('k', 1000, 2500)).toBe(true);
    });

    it('isStale：无版本戳的 key 保守判为 stale（无新鲜度信息）', () => {
      expect(coordinator.isStale('never-written', 1000, 9999)).toBe(true);
    });

    it('clearSharedContext 同时清空版本戳', () => {
      coordinator.shareDiscovery('k', 'v', 1000);
      coordinator.clearSharedContext();
      expect(coordinator.getSharedContext().lastUpdated.size).toBe(0);
      expect(coordinator.getLastUpdated('k')).toBeUndefined();
    });

    it('export/import 往返保留版本戳', () => {
      coordinator.shareDiscovery('k', 'v', 1234);
      const exported = coordinator.exportSharedContext();
      expect(exported.lastUpdated).toEqual({ k: 1234 });

      const fresh = new ParallelAgentCoordinator();
      fresh.importSharedContext(exported);
      expect(fresh.getLastUpdated('k')).toBe(1234);
      expect(fresh.isStale('k', 1000, 1500)).toBe(false);
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

    it('作为兼容 facade 委托统一 GraphRunner 路径', async () => {
      const result = await coordinator.executeWithDAG([
        makeTask('a', { role: 'coder' }),
      ]);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].taskId).toBe('a');
      expect(executorState.executeMock).toHaveBeenCalledTimes(1);
      expect(schedulerState.executeMock).not.toHaveBeenCalled();
    });

    it('Graph executor 返回失败节点时收集 errors', async () => {
      executorState.executeMock.mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'nope',
        iterations: 1,
        toolsUsed: [],
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
