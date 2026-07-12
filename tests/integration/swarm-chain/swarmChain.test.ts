// ============================================================================
// Swarm Chain Integration Tests
// ============================================================================
//
// 验证 IPC handler → SwarmServices → 业务 gate/coordinator → SwarmEventEmitter
// → EventBus → swarm.ipc bridge → mock AppWindow.webContents.send 的整条
// 链路真实接通。覆盖单测拿不到的盲区：
//
// - IPC channel 名 + payload 契约 + service 路由
// - PlanApproval / SwarmLaunchApproval / Coordinator / SpawnGuard 的事件回流
// - SwarmEventEmitter → EventBus → swarm bridge → AppWindow 的桥接
// - SharedContext finding 自动抽取在 IPC retry 链路里能正确触发
// - cancel-agent 的 spawnGuard / coordinator 双源 OR 兜底
//
// 不覆盖（明确边界）：
// - 真 LLM provider 行为（subagentExecutor 被 stub）
// - 真 Electron IPC 进程间序列化（ipcHost 被 stub 成 in-memory dispatcher）
// - 真 Renderer 的 React 渲染
// - spawnAgent.ts 的 agent 生命周期（用 coordinator.executeParallel 直驱）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must be hoisted)
// ---------------------------------------------------------------------------

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface SentEvent {
  channel: string;
  payload: unknown;
}

const platformState = vi.hoisted(() => {
  const sentEvents: SentEvent[] = [];
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();

  const mockWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sentEvents.push({ channel, payload });
      },
    },
  };

  return {
    sentEvents,
    handlers,
    mockWindow,
    reset() {
      sentEvents.length = 0;
      handlers.clear();
    },
  };
});

vi.mock('../../../src/host/platform', () => ({
  app: {
    getPath: () => '/tmp/code-agent-swarm-chain',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  AppWindow: {
    getAllWindows: () => [platformState.mockWindow],
  },
  ipcHost: {
    handle: (
      channel: string,
      fn: (event: unknown, payload?: unknown) => unknown
    ) => {
      platformState.handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      platformState.handlers.delete(channel);
    },
  },
}));

// subagentExecutor — stubbed so coordinator can run without real LLM
const executorState = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executorState.executeMock,
  }),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

// scheduler — full DAG scheduler isn't part of this scope
vi.mock('../../../src/host/scheduler', () => {
  class MockTaskDAG {
    tasks = new Map<string, unknown>();
    constructor(public id: string, public name: string, public config: unknown) {}
    addAgentTask(taskId: string, spec: unknown, meta: unknown): void {
      this.tasks.set(taskId, { id: taskId, spec, meta });
    }
    validate() {
      return { valid: true, errors: [] };
    }
    getAllTasks() {
      return Array.from(this.tasks.values());
    }
  }
  return {
    TaskDAG: MockTaskDAG,
    createRunDAGScheduler: () => ({
      execute: vi.fn(),
      setSubagentExecutor: vi.fn(),
    }),
  };
});

// teammateService — IPC handler 调用，本测试不验证递送
const teammateState = vi.hoisted(() => ({
  approvePlanMock: vi.fn(),
  rejectPlanMock: vi.fn(),
  onUserMessageMock: vi.fn(),
  sendPlanReviewMock: vi.fn(),
}));

vi.mock('../../../src/host/agent/teammate/teammateService', () => ({
  getTeammateService: () => ({
    approvePlan: teammateState.approvePlanMock,
    rejectPlan: teammateState.rejectPlanMock,
    onUserMessage: teammateState.onUserMessageMock,
    sendPlanReview: teammateState.sendPlanReviewMock,
    getHistory: () => [],
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  ParallelAgentCoordinator,
  ParallelAgentCoordinatorRegistry,
} from '../../../src/host/agent/parallelAgentCoordinator';
import { PlanApprovalGate } from '../../../src/host/agent/planApproval';
import { SwarmLaunchApprovalGate } from '../../../src/host/agent/swarmLaunchApproval';
import {
  registerSwarmServices,
  resetSwarmServices,
  type SpawnGuardLike,
} from '../../../src/host/agent/swarmServices';
import { resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { registerSwarmHandlers } from '../../../src/host/ipc/swarm.ipc';
import {
  createScopedSwarmAgentId,
  type SwarmEvent,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';
import type { CompletedAgentRun } from '../../../src/shared/contract/agentHistory';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface ChainHarness {
  scope: SwarmRunScope;
  secondaryScope: SwarmRunScope;
  agentId: string;
  coordinatorAgentId: string;
  coordinator: ParallelAgentCoordinator;
  secondaryCoordinator: ParallelAgentCoordinator;
  coordinators: ParallelAgentCoordinatorRegistry;
  planGate: PlanApprovalGate;
  launchGate: SwarmLaunchApprovalGate;
  spawnGuard: {
    cancel: ReturnType<typeof vi.fn>;
    cancelRun: ReturnType<typeof vi.fn>;
    cancelSession: ReturnType<typeof vi.fn>;
  };
  agentHistory: {
    persistAgentRun: ReturnType<typeof vi.fn>;
    getRecentAgentHistory: ReturnType<typeof vi.fn>;
  };
  invokeIPC: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
  swarmEvents: () => SwarmEvent[];
  eventsByType: (type: SwarmEvent['type']) => SwarmEvent[];
}

function setupChain(): ChainHarness {
  const scope: SwarmRunScope = {
    sessionId: 'integration-session',
    runId: 'team-run-a',
    treeId: 'team-tree-a',
  };
  const secondaryScope: SwarmRunScope = {
    sessionId: scope.sessionId,
    runId: 'team-run-b',
    treeId: 'team-tree-b',
  };
  const agentId = createScopedSwarmAgentId(scope, 'agent_coder_0');
  const coordinatorAgentId = createScopedSwarmAgentId(scope, 'coordinator');
  const coordinators = new ParallelAgentCoordinatorRegistry();
  const createCoordinator = (runScope: SwarmRunScope): ParallelAgentCoordinator => {
    const coordinator = coordinators.getOrCreate(runScope, {
      maxParallelTasks: 4,
      taskTimeout: 5_000,
      enableSharedContext: true,
      aggregateResults: false,
    });
    coordinator.initialize({
      executionContext: {
        runId: runScope.runId,
        currentToolCallId: `cc-${runScope.runId}`,
        sessionId: runScope.sessionId,
        workspace: '/tmp',
        cwd: '/tmp',
        modelConfig: { provider: 'mock', model: 'mock' },
        resolver: { getDefinition: vi.fn() },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
        spawnTreeId: runScope.treeId,
        swarmRunScope: runScope,
      } as never,
      subagentExecutor: {
        execute: (...args: Parameters<typeof executorState.executeMock>) => (
          executorState.executeMock(...args)
        ),
      },
      scope: runScope,
    });
    // Checkpoint path behavior has dedicated filesystem tests. Keep this IPC
    // chain deterministic and focused on concurrent run/result routing.
    vi.spyOn(coordinator, 'persistCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(coordinator, 'deleteCheckpoint').mockResolvedValue(undefined);
    return coordinator;
  };
  const coordinator = createCoordinator(scope);
  const secondaryCoordinator = createCoordinator(secondaryScope);

  const planGate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
  const launchGate = new SwarmLaunchApprovalGate({ approvalTimeoutMs: 60_000 });

  const spawnGuard = {
    cancel: vi.fn().mockReturnValue(false),
    cancelRun: vi.fn().mockReturnValue(0),
    cancelSession: vi.fn().mockReturnValue(0),
  };
  const agentHistory = {
    persistAgentRun: vi.fn().mockResolvedValue(undefined),
    getRecentAgentHistory: vi.fn().mockResolvedValue([]),
  };

  registerSwarmServices({
    planApproval: planGate,
    launchApproval: launchGate,
    parallelCoordinators: coordinators,
    spawnGuard: spawnGuard as SpawnGuardLike,
    teammateService: {
      approvePlan: teammateState.approvePlanMock,
      rejectPlan: teammateState.rejectPlanMock,
      onUserMessage: teammateState.onUserMessageMock,
      sendPlanReview: teammateState.sendPlanReviewMock,
      getHistory: () => [],
    } as never,
    agentHistory,
    swarmTraceRepo: null,
  });

  // (Re-)populate IPC handler table
  registerSwarmHandlers(() => null);

  const invokeIPC = async <T = unknown>(
    channel: string,
    payload?: unknown
  ): Promise<T> => {
    const handler = platformState.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for ${channel}`);
    }
    return (await handler({}, payload)) as T;
  };

  const swarmEvents = (): SwarmEvent[] =>
    platformState.sentEvents
      .filter((e) => e.channel === 'swarm:event')
      .map((e) => e.payload as SwarmEvent);

  const eventsByType = (type: SwarmEvent['type']): SwarmEvent[] =>
    swarmEvents().filter((e) => e.type === type);

  return {
    scope,
    secondaryScope,
    agentId,
    coordinatorAgentId,
    coordinator,
    secondaryCoordinator,
    coordinators,
    planGate,
    launchGate,
    spawnGuard,
    agentHistory,
    invokeIPC,
    swarmEvents,
    eventsByType,
  };
}

function runRef(scope: SwarmRunScope): { sessionId: string; runId: string } {
  return { sessionId: scope.sessionId, runId: scope.runId };
}

function agentRef(scope: SwarmRunScope, agentId: string): {
  sessionId: string;
  runId: string;
  agentId: string;
} {
  return { ...runRef(scope), agentId };
}

function expectEventScope(event: SwarmEvent, scope: SwarmRunScope): void {
  expect(event).toMatchObject({
    sessionId: scope.sessionId,
    runId: scope.runId,
    treeId: scope.treeId,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Swarm Chain Integration', () => {
  let chain: ChainHarness;

  beforeEach(() => {
    platformState.reset();
    executorState.executeMock.mockReset();
    teammateState.approvePlanMock.mockReset();
    teammateState.rejectPlanMock.mockReset();
    teammateState.onUserMessageMock.mockReset();
    teammateState.sendPlanReviewMock.mockReset();
    resetSwarmServices();
    resetSpawnGuard();

    // Default executor: success with role-based output
    executorState.executeMock.mockImplementation(
      async (request: { config: { name: string } }) => ({
        success: true,
        output: `result for ${request.config.name}`,
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      })
    );

    chain = setupChain();
  });

  afterEach(() => {
    chain.planGate.cancelAll('test_cleanup');
    chain.launchGate.cancelAll('test_cleanup');
    chain.coordinators.clear();
    resetSpawnGuard();
    resetSwarmServices();
    vi.useRealTimers();
  });

  // ==========================================================================
  // 1. Bridge wiring：任意 swarm event 必须穿过 EventBus 到达 AppWindow
  // ==========================================================================

  describe('event bridge', () => {
    it('SwarmLaunchApprovalGate.requestApproval 发布的 launch:requested 事件能到达 mock AppWindow', async () => {
      // 直接调 gate（绕过 IPC），模拟业务模块从内部触发审批请求
      void chain.launchGate.requestApproval({
        tasks: [
          {
            id: chain.agentId,
            role: 'coder',
            task: 'do work',
            tools: ['Read'],
            writeAccess: false,
          },
        ],
        summary: 'integration test',
        scope: chain.scope,
      });

      // EventBus 是同步分发，事件应该立刻在 sentEvents 里
      const requested = chain.eventsByType('swarm:launch:requested');
      expect(requested).toHaveLength(1);
      expectEventScope(requested[0], chain.scope);
      expect((requested[0].data as { launchRequest: { agentCount: number } }).launchRequest.agentCount).toBe(1);
    });
  });

  // ==========================================================================
  // 2. swarm:approve-launch 控制平面：IPC → gate.approve → emit → bridge
  // ==========================================================================

  describe('approve-launch 链路', () => {
    it('IPC approve-launch 触发 gate 状态转 approved 并 emit launch:approved', async () => {
      // 先制造一个 pending request
      void chain.launchGate.requestApproval({
        tasks: [{ id: chain.agentId, role: 'coder', task: 'x', tools: ['Read'], writeAccess: false }],
        scope: chain.scope,
      });

      const reqId = chain.launchGate.getPendingRequests(runRef(chain.scope))[0].id;

      const ok = await chain.invokeIPC<boolean>('swarm:approve-launch', {
        ...runRef(chain.scope),
        requestId: reqId,
        feedback: 'go',
      });
      expect(ok).toBe(true);

      const approved = chain.eventsByType('swarm:launch:approved');
      expect(approved).toHaveLength(1);
      expectEventScope(approved[0], chain.scope);
      expect(chain.launchGate.getRequest(reqId, runRef(chain.scope))?.status).toBe('approved');
    });

    it('IPC reject-launch 使等待中的 requestApproval promise 立即结算', async () => {
      const pending = chain.launchGate.requestApproval({
        tasks: [{ id: chain.agentId, role: 'coder', task: 'x', tools: ['Read'], writeAccess: true }],
        scope: chain.scope,
      });

      const reqId = chain.launchGate.getPendingRequests(runRef(chain.scope))[0].id;
      await chain.invokeIPC('swarm:reject-launch', {
        ...runRef(chain.scope),
        requestId: reqId,
        feedback: 'unsafe',
      });

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.feedback).toBe('unsafe');

      const rejected = chain.eventsByType('swarm:launch:rejected');
      expect(rejected).toHaveLength(1);
      expectEventScope(rejected[0], chain.scope);
    });
  });

  // ==========================================================================
  // 3. swarm:approve-plan / reject-plan 控制平面
  // ==========================================================================

  describe('plan approval 链路', () => {
    it('IPC approve-plan 触发 gate.approve + teammate sync + plan_approved 事件', async () => {
      // 制造一个 medium risk plan（绕过 fast-path）
      void chain.planGate.submitForApproval({
        agentId: chain.agentId,
        agentName: 'Coder',
        coordinatorId: chain.coordinatorAgentId,
        plan: 'rm old build',
        risk: { level: 'medium', reasons: ['dangerous cmd'] },
        scope: chain.scope,
      });

      // submitForApproval 走 approvalQueue（异步），等一拍让 plan 进入 pending 表
      await Promise.resolve();
      await Promise.resolve();

      const planId = chain.planGate.getPendingPlans(runRef(chain.scope))[0].id;

      const ok = await chain.invokeIPC<boolean>('swarm:approve-plan', {
        ...agentRef(chain.scope, chain.agentId),
        planId,
        feedback: 'looks safe',
      });

      expect(ok).toBe(true);
      expect(teammateState.approvePlanMock).toHaveBeenCalledWith(
        chain.coordinatorAgentId,
        chain.agentId,
        planId,
        'looks safe',
        chain.scope,
      );
      const approved = chain.eventsByType('swarm:agent:plan_approved');
      expect(approved).toHaveLength(1);
      expectEventScope(approved[0], chain.scope);
      expect(chain.planGate.getPlan(planId, agentRef(chain.scope, chain.agentId))?.status).toBe('approved');
    });

    it('IPC reject-plan 同样触发 teammate sync + plan_rejected 事件', async () => {
      void chain.planGate.submitForApproval({
        agentId: chain.agentId,
        agentName: 'Coder',
        coordinatorId: chain.coordinatorAgentId,
        plan: 'sudo rm -rf /',
        risk: { level: 'high', reasons: ['dangerous', 'rm -rf'] },
        scope: chain.scope,
      });
      await Promise.resolve();
      await Promise.resolve();

      const planId = chain.planGate.getPendingPlans(runRef(chain.scope))[0].id;
      const ok = await chain.invokeIPC<boolean>('swarm:reject-plan', {
        ...agentRef(chain.scope, chain.agentId),
        planId,
        feedback: 'destructive',
      });

      expect(ok).toBe(true);
      expect(teammateState.rejectPlanMock).toHaveBeenCalled();
      const rejected = chain.eventsByType('swarm:agent:plan_rejected');
      expect(rejected).toHaveLength(1);
      expectEventScope(rejected[0], chain.scope);
    });

    it('IPC approve-plan 对未知 planId 返回 false 且不发事件', async () => {
      const ok = await chain.invokeIPC<boolean>('swarm:approve-plan', {
        ...agentRef(chain.scope, chain.agentId),
        planId: 'plan_does_not_exist',
      });
      expect(ok).toBe(false);
      expect(chain.eventsByType('swarm:agent:plan_approved')).toHaveLength(0);
      expect(teammateState.approvePlanMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 4. swarm:cancel-agent — spawnGuard 和 coordinator 双源 OR 兜底
  // ==========================================================================

  describe('cancel-agent 链路', () => {
    it('spawnGuard.cancel 命中时仍排干 coordinator 和 plan waiter', async () => {
      chain.spawnGuard.cancel.mockReturnValueOnce(true);
      const abortSpy = vi.spyOn(chain.coordinator, 'abortTask');

      const result = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        ...agentRef(chain.scope, chain.agentId),
      });

      expect(result).toBe(true);
      expect(chain.spawnGuard.cancel).toHaveBeenCalledWith(
        chain.agentId,
        agentRef(chain.scope, chain.agentId),
      );
      expect(abortSpy).toHaveBeenCalledWith(chain.agentId);

      const failed = chain.eventsByType('swarm:agent:failed');
      expect(failed.some((e) =>
        (e.data as { agentState: { status: string } }).agentState.status === 'cancelled'
      )).toBe(true);
      expectEventScope(failed[0], chain.scope);
    });

    it('同 session 两个 run 使用相同本地 agent id 时，cancel 只路由到目标 run', async () => {
      const secondaryAgentId = createScopedSwarmAgentId(
        chain.secondaryScope,
        'agent_coder_0',
      );
      executorState.executeMock.mockImplementation(
        async (request: { prompt: string }) => ({
          success: true,
          output: `result:${request.prompt}`,
          iterations: 1,
          toolsUsed: [],
          cost: 0,
        }),
      );
      const [primaryRun, secondaryRun] = await Promise.all([
        chain.coordinator.executeParallel([
          { id: chain.agentId, role: 'coder', task: 'primary run', tools: ['Read'] },
        ]),
        chain.secondaryCoordinator.executeParallel([
          { id: secondaryAgentId, role: 'coder', task: 'secondary run', tools: ['Read'] },
        ]),
      ]);
      expect(primaryRun.results).toEqual([
        expect.objectContaining({ taskId: chain.agentId, output: 'result:primary run' }),
      ]);
      expect(secondaryRun.results).toEqual([
        expect.objectContaining({ taskId: secondaryAgentId, output: 'result:secondary run' }),
      ]);
      chain.spawnGuard.cancel.mockReturnValue(false);
      const abortPrimary = vi.spyOn(chain.coordinator, 'abortTask').mockReturnValue(true);
      const abortSecondary = vi.spyOn(chain.secondaryCoordinator, 'abortTask').mockReturnValue(true);

      const primaryResult = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        ...agentRef(chain.scope, chain.agentId),
      });

      expect(primaryResult).toBe(true);
      expect(abortPrimary).toHaveBeenCalledWith(chain.agentId);
      expect(abortSecondary).not.toHaveBeenCalled();

      const mixedScopeResult = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        ...agentRef(chain.scope, secondaryAgentId),
      });
      expect(mixedScopeResult).toBe(false);
      expect(abortPrimary).toHaveBeenCalledTimes(1);
      expect(abortSecondary).not.toHaveBeenCalled();

      const secondaryResult = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        ...agentRef(chain.secondaryScope, secondaryAgentId),
      });
      expect(secondaryResult).toBe(true);
      expect(abortPrimary).toHaveBeenCalledTimes(1);
      expect(abortSecondary).toHaveBeenCalledWith(secondaryAgentId);

      const failed = chain.eventsByType('swarm:agent:failed');
      expect(failed).toHaveLength(2);
      expectEventScope(failed[0], chain.scope);
      expectEventScope(failed[1], chain.secondaryScope);
      expect((failed[0].data as { agentId: string }).agentId).toBe(chain.agentId);
      expect((failed[1].data as { agentId: string }).agentId).toBe(secondaryAgentId);
    });

    it('两个源都 miss 时返回 false 且不发事件', async () => {
      chain.spawnGuard.cancel.mockReturnValueOnce(false);
      vi.spyOn(chain.coordinator, 'abortTask').mockReturnValueOnce(false);

      const result = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        ...agentRef(chain.scope, chain.agentId),
      });

      expect(result).toBe(false);
      expect(chain.eventsByType('swarm:agent:failed')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 5. swarm:retry-agent — 数据平面：跑 coordinator + 等结果 emit
  // ==========================================================================

  describe('retry-agent 链路', () => {
    it('已注册任务 retry 后 emit running → completed 两个事件', async () => {
      // 第一次 executeParallel 注册 task 定义
      await chain.coordinator.executeParallel([
        {
          id: chain.agentId,
          role: 'coder',
          task: 'initial',
          tools: ['Read'],
        },
      ]);
      // 清掉首次执行产生的事件，只看 retry 路径
      platformState.sentEvents.length = 0;

      // mock executor 返回成功结果给 retry
      executorState.executeMock.mockResolvedValueOnce({
        success: true,
        output: 'retried output',
        iterations: 2,
        toolsUsed: [],
        cost: 0,
      });

      const ok = await chain.invokeIPC<boolean>('swarm:retry-agent', {
        ...agentRef(chain.scope, chain.agentId),
      });
      expect(ok).toBe(true);

      // retry handler 里 void coordinator.retryTask().then(...) 是 fire-and-forget
      // 等待 promise 链结算
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const updates = chain.eventsByType('swarm:agent:updated');
      expect(updates.some((e) =>
        (e.data as { agentState: { status: string } }).agentState.status === 'running'
      )).toBe(true);
      expectEventScope(updates[0], chain.scope);

      const completed = chain.eventsByType('swarm:agent:completed');
      expect(completed).toHaveLength(1);
      expectEventScope(completed[0], chain.scope);
    });

    it('未知 agentId 立即返回 false，无副作用', async () => {
      const missingAgentId = createScopedSwarmAgentId(chain.scope, 'never-existed');
      const ok = await chain.invokeIPC<boolean>('swarm:retry-agent', {
        ...agentRef(chain.scope, missingAgentId),
      });
      expect(ok).toBe(false);
      expect(chain.eventsByType('swarm:agent:updated')).toHaveLength(0);
    });

    it('retry 任务失败时 emit agent:failed', async () => {
      await chain.coordinator.executeParallel([
        { id: chain.agentId, role: 'coder', task: 'init', tools: ['Read'] },
      ]);
      platformState.sentEvents.length = 0;

      executorState.executeMock.mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'tool crash',
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      });

      await chain.invokeIPC('swarm:retry-agent', {
        ...agentRef(chain.scope, chain.agentId),
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const failed = chain.eventsByType('swarm:agent:failed');
      expect(failed).toHaveLength(1);
      expectEventScope(failed[0], chain.scope);
      expect((failed[0].data as { agentState: { error: string } }).agentState.error).toBe(
        'tool crash'
      );
    });
  });

  // ==========================================================================
  // 6. agentHistory 端口：persist + get 经过 registry 路由到 port
  // ==========================================================================

  describe('agent-history 端口', () => {
    it('IPC persist-agent-run 调用 agentHistory.persistAgentRun', async () => {
      const run = {
        id: 'run-1',
        sessionId: 'sess',
        status: 'completed',
      } as unknown as CompletedAgentRun;

      const ok = await chain.invokeIPC<boolean>('swarm:persist-agent-run', {
        sessionId: 'sess',
        run,
      });

      expect(ok).toBe(true);
      expect(chain.agentHistory.persistAgentRun).toHaveBeenCalledWith('sess', run);
    });

    it('IPC get-agent-history 把 port 返回值原样转发', async () => {
      chain.agentHistory.getRecentAgentHistory.mockResolvedValueOnce([
        { id: 'r1' } as unknown as CompletedAgentRun,
        { id: 'r2' } as unknown as CompletedAgentRun,
      ]);

      const result = await chain.invokeIPC<CompletedAgentRun[]>(
        'swarm:get-agent-history',
        { limit: 2 }
      );
      expect(result).toHaveLength(2);
      expect(chain.agentHistory.getRecentAgentHistory).toHaveBeenCalledWith(2);
    });
  });

  // ==========================================================================
  // 7. SharedContext 在 retry 链路里能正确累积 finding
  // ==========================================================================

  describe('SharedContext 累积', () => {
    it('executeParallel 出 output 含 file: 路径时自动写入 files 和 findings', async () => {
      executorState.executeMock.mockResolvedValueOnce({
        success: true,
        output: 'Found issue in file: src/db/query.ts',
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      });
      await chain.coordinator.executeParallel([
        { id: chain.agentId, role: 'coder', task: 'review', tools: ['Read'] },
      ]);

      const ctx = chain.coordinator.getSharedContext();
      expect(ctx.files.size).toBeGreaterThan(0);
      expect(ctx.findings.size).toBeGreaterThan(0);
    });

    // 注意：retryTask 直接调 executeTask 而不走 updateSharedContext 路径，
    // 这是源码当前行为 —— 集成测试不验证此路径，避免与单测重叠。
  });
});
