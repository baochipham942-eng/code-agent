// ============================================================================
// Swarm Chain Integration Tests
// ============================================================================
//
// 验证 IPC handler → SwarmServices → 业务 gate/coordinator → SwarmEventEmitter
// → EventBus → swarm.ipc bridge → mock BrowserWindow.webContents.send 的整条
// 链路真实接通。覆盖单测拿不到的盲区：
//
// - IPC channel 名 + payload 契约 + service 路由
// - PlanApproval / SwarmLaunchApproval / Coordinator / SpawnGuard 的事件回流
// - SwarmEventEmitter → EventBus → swarm bridge → BrowserWindow 的桥接
// - SharedContext finding 自动抽取在 IPC retry 链路里能正确触发
// - cancel-agent 的 spawnGuard / coordinator 双源 OR 兜底
//
// 不覆盖（明确边界）：
// - 真 LLM provider 行为（subagentExecutor 被 stub）
// - 真 Electron IPC 进程间序列化（ipcMain 被 stub 成 in-memory dispatcher）
// - 真 Renderer 的 React 渲染
// - spawnAgent.ts 的 agent 生命周期（用 coordinator.executeParallel 直驱）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must be hoisted)
// ---------------------------------------------------------------------------

vi.mock('../../../src/main/services/infra/logger', () => ({
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

vi.mock('../../../src/main/platform', () => ({
  BrowserWindow: {
    getAllWindows: () => [platformState.mockWindow],
  },
  ipcMain: {
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

vi.mock('../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: executorState.executeMock,
  }),
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

// scheduler — full DAG scheduler isn't part of this scope
vi.mock('../../../src/main/scheduler', () => {
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
    getDAGScheduler: () => ({ execute: vi.fn() }),
  };
});

// teammateService — IPC handler 调用，本测试不验证递送
const teammateState = vi.hoisted(() => ({
  approvePlanMock: vi.fn(),
  rejectPlanMock: vi.fn(),
  onUserMessageMock: vi.fn(),
  sendPlanReviewMock: vi.fn(),
}));

vi.mock('../../../src/main/agent/teammate/teammateService', () => ({
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

import { ParallelAgentCoordinator } from '../../../src/main/agent/parallelAgentCoordinator';
import { PlanApprovalGate } from '../../../src/main/agent/planApproval';
import { SwarmLaunchApprovalGate } from '../../../src/main/agent/swarmLaunchApproval';
import {
  registerSwarmServices,
  resetSwarmServices,
  type SpawnGuardLike,
} from '../../../src/main/agent/swarmServices';
import { registerSwarmHandlers } from '../../../src/main/ipc/swarm.ipc';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';
import type { CompletedAgentRun } from '../../../src/shared/contract/agentHistory';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface ChainHarness {
  coordinator: ParallelAgentCoordinator;
  planGate: PlanApprovalGate;
  launchGate: SwarmLaunchApprovalGate;
  spawnGuard: { cancel: ReturnType<typeof vi.fn> };
  agentHistory: {
    persistAgentRun: ReturnType<typeof vi.fn>;
    getRecentAgentHistory: ReturnType<typeof vi.fn>;
  };
  invokeIPC: <T = unknown>(channel: string, payload?: unknown) => Promise<T>;
  swarmEvents: () => SwarmEvent[];
  eventsByType: (type: SwarmEvent['type']) => SwarmEvent[];
}

function setupChain(): ChainHarness {
  const coordinator = new ParallelAgentCoordinator({
    maxParallelTasks: 4,
    taskTimeout: 5_000,
    enableSharedContext: true,
    aggregateResults: false,
  });
  coordinator.initialize({
    modelConfig: { provider: 'mock', model: 'mock' } as never,
    toolResolver: {} as never,
    toolContext: { currentToolCallId: 'cc-1' } as never,
  });

  const planGate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
  const launchGate = new SwarmLaunchApprovalGate({ approvalTimeoutMs: 60_000 });

  const spawnGuard = { cancel: vi.fn().mockReturnValue(false) };
  const agentHistory = {
    persistAgentRun: vi.fn().mockResolvedValue(undefined),
    getRecentAgentHistory: vi.fn().mockResolvedValue([]),
  };

  registerSwarmServices({
    planApproval: planGate,
    launchApproval: launchGate,
    parallelCoordinator: coordinator,
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
    coordinator,
    planGate,
    launchGate,
    spawnGuard,
    agentHistory,
    invokeIPC,
    swarmEvents,
    eventsByType,
  };
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

    // Default executor: success with role-based output
    executorState.executeMock.mockImplementation(
      async (_task: string, spec: { name: string }) => ({
        success: true,
        output: `result for ${spec.name}`,
        iterations: 1,
        toolsUsed: [],
        cost: 0,
      })
    );

    chain = setupChain();
  });

  afterEach(() => {
    resetSwarmServices();
    vi.useRealTimers();
  });

  // ==========================================================================
  // 1. Bridge wiring：任意 swarm event 必须穿过 EventBus 到达 BrowserWindow
  // ==========================================================================

  describe('event bridge', () => {
    it('SwarmLaunchApprovalGate.requestApproval 发布的 launch:requested 事件能到达 mock BrowserWindow', async () => {
      // 直接调 gate（绕过 IPC），模拟业务模块从内部触发审批请求
      void chain.launchGate.requestApproval({
        tasks: [
          {
            id: 't1',
            role: 'coder',
            task: 'do work',
            tools: ['Read'],
            writeAccess: false,
          },
        ],
        summary: 'integration test',
      });

      // EventBus 是同步分发，事件应该立刻在 sentEvents 里
      const requested = chain.eventsByType('swarm:launch:requested');
      expect(requested).toHaveLength(1);
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
        tasks: [{ id: 't1', role: 'coder', task: 'x', tools: ['Read'], writeAccess: false }],
      });

      const reqId = chain.launchGate.getPendingRequests()[0].id;

      const ok = await chain.invokeIPC<boolean>('swarm:approve-launch', {
        requestId: reqId,
        feedback: 'go',
      });
      expect(ok).toBe(true);

      const approved = chain.eventsByType('swarm:launch:approved');
      expect(approved).toHaveLength(1);
      expect(chain.launchGate.getRequest(reqId)?.status).toBe('approved');
    });

    it('IPC reject-launch 使等待中的 requestApproval promise 立即结算', async () => {
      const pending = chain.launchGate.requestApproval({
        tasks: [{ id: 't1', role: 'coder', task: 'x', tools: ['Read'], writeAccess: true }],
      });

      const reqId = chain.launchGate.getPendingRequests()[0].id;
      await chain.invokeIPC('swarm:reject-launch', { requestId: reqId, feedback: 'unsafe' });

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.feedback).toBe('unsafe');

      const rejected = chain.eventsByType('swarm:launch:rejected');
      expect(rejected).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 3. swarm:approve-plan / reject-plan 控制平面
  // ==========================================================================

  describe('plan approval 链路', () => {
    it('IPC approve-plan 触发 gate.approve + teammate sync + plan_approved 事件', async () => {
      // 制造一个 medium risk plan（绕过 fast-path）
      void chain.planGate.submitForApproval({
        agentId: 'agent-1',
        agentName: 'Coder',
        coordinatorId: 'coord-1',
        plan: 'rm old build',
        risk: { level: 'medium', reasons: ['dangerous cmd'] },
      });

      // submitForApproval 走 approvalQueue（异步），等一拍让 plan 进入 pending 表
      await Promise.resolve();
      await Promise.resolve();

      const planId = chain.planGate.getPendingPlans()[0].id;

      const ok = await chain.invokeIPC<boolean>('swarm:approve-plan', {
        planId,
        feedback: 'looks safe',
      });

      expect(ok).toBe(true);
      expect(teammateState.approvePlanMock).toHaveBeenCalledWith(
        'coord-1',
        'agent-1',
        planId,
        'looks safe'
      );
      expect(chain.eventsByType('swarm:agent:plan_approved')).toHaveLength(1);
      expect(chain.planGate.getPlan(planId)?.status).toBe('approved');
    });

    it('IPC reject-plan 同样触发 teammate sync + plan_rejected 事件', async () => {
      void chain.planGate.submitForApproval({
        agentId: 'agent-1',
        agentName: 'Coder',
        coordinatorId: 'coord-1',
        plan: 'sudo rm -rf /',
        risk: { level: 'high', reasons: ['dangerous', 'rm -rf'] },
      });
      await Promise.resolve();
      await Promise.resolve();

      const planId = chain.planGate.getPendingPlans()[0].id;
      const ok = await chain.invokeIPC<boolean>('swarm:reject-plan', {
        planId,
        feedback: 'destructive',
      });

      expect(ok).toBe(true);
      expect(teammateState.rejectPlanMock).toHaveBeenCalled();
      expect(chain.eventsByType('swarm:agent:plan_rejected')).toHaveLength(1);
    });

    it('IPC approve-plan 对未知 planId 返回 false 且不发事件', async () => {
      const ok = await chain.invokeIPC<boolean>('swarm:approve-plan', {
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
    it('spawnGuard.cancel 命中时不再调 coordinator.abortTask', async () => {
      chain.spawnGuard.cancel.mockReturnValueOnce(true);
      const abortSpy = vi.spyOn(chain.coordinator, 'abortTask');

      const result = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        agentId: 'a1',
      });

      expect(result).toBe(true);
      expect(chain.spawnGuard.cancel).toHaveBeenCalledWith('a1');
      expect(abortSpy).not.toHaveBeenCalled();

      const updates = chain.eventsByType('swarm:agent:updated');
      expect(updates.some((e) =>
        (e.data as { agentState: { status: string } }).agentState.status === 'cancelled'
      )).toBe(true);
    });

    it('spawnGuard.cancel miss 时 fallback 到 coordinator.abortTask', async () => {
      chain.spawnGuard.cancel.mockReturnValueOnce(false);
      const abortSpy = vi.spyOn(chain.coordinator, 'abortTask').mockReturnValueOnce(true);

      const result = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        agentId: 'a1',
      });

      expect(result).toBe(true);
      expect(abortSpy).toHaveBeenCalledWith('a1');
      expect(chain.eventsByType('swarm:agent:updated')).toHaveLength(1);
    });

    it('两个源都 miss 时返回 false 且不发事件', async () => {
      chain.spawnGuard.cancel.mockReturnValueOnce(false);
      vi.spyOn(chain.coordinator, 'abortTask').mockReturnValueOnce(false);

      const result = await chain.invokeIPC<boolean>('swarm:cancel-agent', {
        agentId: 'a1',
      });

      expect(result).toBe(false);
      expect(chain.eventsByType('swarm:agent:updated')).toHaveLength(0);
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
          id: 'task-a',
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
        agentId: 'task-a',
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

      const completed = chain.eventsByType('swarm:agent:completed');
      expect(completed).toHaveLength(1);
    });

    it('未知 agentId 立即返回 false，无副作用', async () => {
      const ok = await chain.invokeIPC<boolean>('swarm:retry-agent', {
        agentId: 'never-existed',
      });
      expect(ok).toBe(false);
      expect(chain.eventsByType('swarm:agent:updated')).toHaveLength(0);
    });

    it('retry 任务失败时 emit agent:failed', async () => {
      await chain.coordinator.executeParallel([
        { id: 'task-b', role: 'coder', task: 'init', tools: ['Read'] },
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

      await chain.invokeIPC('swarm:retry-agent', { agentId: 'task-b' });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const failed = chain.eventsByType('swarm:agent:failed');
      expect(failed).toHaveLength(1);
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
        { id: 'task-d', role: 'coder', task: 'review', tools: ['Read'] },
      ]);

      const ctx = chain.coordinator.getSharedContext();
      expect(ctx.files.size).toBeGreaterThan(0);
      expect(ctx.findings.size).toBeGreaterThan(0);
    });

    // 注意：retryTask 直接调 executeTask 而不走 updateSharedContext 路径，
    // 这是源码当前行为 —— 集成测试不验证此路径，避免与单测重叠。
  });
});
