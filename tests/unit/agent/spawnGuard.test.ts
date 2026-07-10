// ============================================================================
// SpawnGuard Tests
// 覆盖并发配额、生命周期、消息队列、通知、持久化恢复
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  getSpawnGuard,
  resetSpawnGuard,
  createTextMessage,
  createAgentMessage,
} from '../../../src/host/agent/spawnGuard';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutor';
import { SPAWN_GUARD } from '../../../src/shared/constants/agent';
import {
  createScopedSwarmAgentId,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';

type Guard = ReturnType<typeof getSpawnGuard>;

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    success: true,
    output: 'done',
    iterations: 1,
    toolsUsed: ['Read'],
    cost: 0,
    ...overrides,
  };
}

/**
 * Register an agent whose promise is resolved immediately, then wait a tick
 * so the `.then` chain inside register() can flip status to completed/failed.
 */
async function registerSettled(
  guard: Guard,
  id: string,
  role: string,
  result: SubagentResult
): Promise<void> {
  const controller = new AbortController();
  guard.register(id, role, `task-${id}`, Promise.resolve(result), controller);
  await Promise.resolve();
  await Promise.resolve();
}

async function registerRejected(
  guard: Guard,
  id: string,
  role: string,
  err: Error
): Promise<void> {
  const controller = new AbortController();
  guard.register(id, role, `task-${id}`, Promise.reject(err), controller);
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpawnGuard', () => {
  let guard: Guard;

  beforeEach(() => {
    resetSpawnGuard();
    guard = getSpawnGuard({ maxAgents: 3, maxDepth: 2 });
  });

  afterEach(() => {
    resetSpawnGuard();
  });

  // ==========================================================================
  // 并发配额
  // ==========================================================================

  describe('并发配额', () => {
    it('空池时 canSpawn 返回 true，getMaxAgents 反映构造配置', () => {
      expect(guard.canSpawn()).toBe(true);
      expect(guard.getMaxAgents()).toBe(3);
      expect(guard.getRunningCount()).toBe(0);
    });

    it('达到 maxAgents 后 canSpawn 返回 false', () => {
      // Use pending promises to keep them in running state
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
      guard.register('a2', 'coder', 't2', pending, new AbortController());
      guard.register('a3', 'coder', 't3', pending, new AbortController());

      expect(guard.getRunningCount()).toBe(3);
      expect(guard.canSpawn()).toBe(false);
    });

    it('已完成的 agent 不再占用配额', async () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
      guard.register('a2', 'coder', 't2', pending, new AbortController());
      await registerSettled(guard, 'a3', 'coder', makeResult());

      expect(guard.getRunningCount()).toBe(2);
      expect(guard.canSpawn()).toBe(true);
    });

    it('checkDepth 以 maxDepth 为上限', () => {
      expect(guard.checkDepth(1)).toBe(true);
      expect(guard.checkDepth(2)).toBe(true);
      expect(guard.checkDepth(3)).toBe(false);
    });

    it('未配置时默认 maxDepth / maxAgents 取自 SPAWN_GUARD 常量（不硬编码）', () => {
      resetSpawnGuard();
      const defaultGuard = getSpawnGuard();
      expect(defaultGuard.getMaxAgents()).toBe(SPAWN_GUARD.MAX_TREE_AGENTS);
      expect(defaultGuard.checkDepth(SPAWN_GUARD.DEFAULT_SPAWN_DEPTH)).toBe(true);
      expect(defaultGuard.checkDepth(SPAWN_GUARD.DEFAULT_SPAWN_DEPTH + 1)).toBe(false);
    });

    it('会话级 maxDepth override 会 clamp 到硬上限', () => {
      resetSpawnGuard();
      const defaultGuard = getSpawnGuard();
      expect(defaultGuard.getMaxDepth(99)).toBe(SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH);
      expect(defaultGuard.checkDepth(SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH, 99)).toBe(true);
      expect(defaultGuard.checkDepth(SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH + 1, 99)).toBe(false);
    });

    it('按 root tree 维护独立槽位池', async () => {
      resetSpawnGuard();
      const treeGuard = getSpawnGuard({ maxAgents: 1 });
      const lease = await treeGuard.acquireSlot({ treeId: 'root-a', timeoutMs: 1000 });

      expect(treeGuard.canSpawn('root-a')).toBe(false);
      expect(treeGuard.canSpawn('root-b')).toBe(true);
      expect(treeGuard.getReservedCount('root-a')).toBe(1);
      expect(treeGuard.getReservedCount('root-b')).toBe(0);

      lease.release();
      expect(treeGuard.canSpawn('root-a')).toBe(true);
    });

    it('同 session/tree 的两个 run 共享配额，但 agent、inbox 和取消域保持隔离', async () => {
      resetSpawnGuard();
      const quotaGuard = getSpawnGuard({ maxAgents: 2 });
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
      const independentScope: SwarmRunScope = {
        sessionId: scopeA.sessionId,
        runId: 'run-independent',
        treeId: 'independent-tree',
      };
      const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
      const agentB = createScopedSwarmAgentId(scopeB, 'agent_coder_0');
      const leaseA = await quotaGuard.acquireSlot({ scope: scopeA });
      const leaseB = await quotaGuard.acquireSlot({ scope: scopeB });
      let queuedRunAGranted = false;
      const queuedRunA = quotaGuard.acquireSlot({ scope: scopeA, timeoutMs: 1_000 }).then(
        (lease) => {
          queuedRunAGranted = true;
          lease.release();
          return null;
        },
        (error: Error) => error,
      );
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const pending = new Promise<SubagentResult>(() => {});
      quotaGuard.register(agentA, 'coder', 'Team A', pending, controllerA, {
        scope: scopeA,
        slotAcquired: true,
      });
      quotaGuard.register(agentB, 'coder', 'Team B', pending, controllerB, {
        scope: scopeB,
        slotAcquired: true,
      });

      expect(leaseA.scope).toEqual(scopeA);
      expect(leaseB.scope).toEqual(scopeB);
      expect(quotaGuard.getReservedCount(scopeA)).toBe(2);
      expect(quotaGuard.getReservedCount(scopeB)).toBe(2);
      expect(quotaGuard.canSpawn(scopeA)).toBe(false);
      expect(quotaGuard.canSpawn(scopeB)).toBe(false);
      const independentLease = await quotaGuard.acquireSlot({ scope: independentScope });
      expect(quotaGuard.getReservedCount(independentScope)).toBe(1);
      independentLease.release();
      expect(quotaGuard.sendMessage(agentA, 'only A', scopeA)).toBe(true);
      expect(quotaGuard.peekMessages(agentA, scopeA)).toHaveLength(1);
      expect(quotaGuard.peekMessages(agentB, scopeB)).toEqual([]);
      expect(quotaGuard.get(agentA, scopeB)).toBeUndefined();

      expect(quotaGuard.cancelRun(scopeA, 'run-a-cancelled')).toBe(1);
      await expect(queuedRunA).resolves.toMatchObject({ message: expect.stringMatching(/cancelled.*run-a-cancelled/i) });
      expect(queuedRunAGranted).toBe(false);
      expect(controllerA.signal.aborted).toBe(true);
      expect(controllerB.signal.aborted).toBe(false);
      expect(quotaGuard.get(agentA, scopeA)?.status).toBe('cancelled');
      expect(quotaGuard.get(agentB, scopeB)?.status).toBe('running');
      expect(quotaGuard.getReservedCount(scopeA)).toBe(1);
      expect(quotaGuard.getReservedCount(scopeB)).toBe(1);

      expect(quotaGuard.cancelRun(scopeB, 'test-cleanup')).toBe(1);
    });

    it('rejects a scoped agent identity registered under another run', () => {
      const scopeA: SwarmRunScope = {
        sessionId: 'session',
        runId: 'run-a',
        treeId: 'tree-a',
      };
      const scopeB: SwarmRunScope = {
        sessionId: 'session',
        runId: 'run-b',
        treeId: 'tree-b',
      };
      const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');

      expect(() => guard.register(
        agentA,
        'coder',
        'wrong run',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: scopeB },
      )).toThrow(/does not match/i);
      expect(guard.getRunningCount()).toBe(0);

      const childA = createScopedSwarmAgentId(scopeA, 'agent_coder_1');
      expect(() => guard.register(
        childA,
        'coder',
        'unscoped parent',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: scopeA, parentId: 'legacy-parent' },
      )).toThrow(/parent agent id must belong to the same run scope/i);

      const sameRunAgent = createScopedSwarmAgentId(scopeA, 'agent_coder_2');
      expect(() => guard.register(
        sameRunAgent,
        'coder',
        'same-run child',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: scopeA, parentId: agentA },
      )).not.toThrow();
      expect(guard.get(sameRunAgent, scopeA)?.parentId).toBe(agentA);

      const nestedScope: SwarmRunScope = {
        sessionId: scopeA.sessionId,
        runId: 'nested-run',
        treeId: scopeA.treeId,
      };
      const nestedAgent = createScopedSwarmAgentId(nestedScope, 'agent_coder_3');
      expect(() => guard.register(
        nestedAgent,
        'coder',
        'nested Team root',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: nestedScope, parentId: agentA },
      )).toThrow(/same run scope/i);

      expect(() => guard.register(
        nestedAgent,
        'coder',
        'nested Team run root',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: nestedScope },
      )).not.toThrow();
      expect(guard.get(nestedAgent, nestedScope)?.parentId).toBeUndefined();

      const foreignTreeParent = createScopedSwarmAgentId(scopeB, 'agent_coder_9');
      const secondNestedAgent = createScopedSwarmAgentId(nestedScope, 'agent_coder_4');
      expect(() => guard.register(
        secondNestedAgent,
        'coder',
        'foreign tree parent',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: nestedScope, parentId: foreignTreeParent },
      )).toThrow(/same run scope/i);

      const foreignSessionParent = createScopedSwarmAgentId({
        sessionId: 'foreign-session',
        runId: nestedScope.runId,
        treeId: nestedScope.treeId,
      }, 'agent_coder_9');
      expect(() => guard.register(
        secondNestedAgent,
        'coder',
        'foreign session parent',
        new Promise<SubagentResult>(() => {}),
        new AbortController(),
        { scope: nestedScope, parentId: foreignSessionParent },
      )).toThrow(/same run scope/i);

      guard.cancelRun(scopeA, 'test-cleanup');
      guard.cancelRun(nestedScope, 'test-cleanup');
    });

    it('超额 spawn 请求 FIFO 排队，释放槽位后按顺序获批', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
      const firstLease = await queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 1000 });
      const grants: string[] = [];
      let secondLease: { release: () => void } | undefined;
      let thirdLease: { release: () => void } | undefined;

      const second = queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 1000 }).then((lease) => {
        grants.push('second');
        secondLease = lease;
      });
      const third = queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 1000 }).then((lease) => {
        grants.push('third');
        thirdLease = lease;
      });

      await Promise.resolve();
      expect(grants).toEqual([]);

      firstLease.release();
      await vi.waitFor(() => expect(grants).toEqual(['second']));
      expect(queueGuard.getReservedCount('root')).toBe(1);

      secondLease?.release();
      await vi.waitFor(() => expect(grants).toEqual(['second', 'third']));

      thirdLease?.release();
      await Promise.all([second, third]);
      expect(queueGuard.getReservedCount('root')).toBe(0);
    });

    it('run A 的排队请求被取消后不会获 lease，run B 的同 tree 请求继续执行', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
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
      const holder = await queueGuard.acquireSlot({ scope: scopeB, timeoutMs: 1_000 });
      let runAGranted = false;
      let runBLease: { release: () => void } | undefined;
      const queuedA = queueGuard.acquireSlot({ scope: scopeA, timeoutMs: 1_000 }).then(
        (lease) => {
          runAGranted = true;
          lease.release();
          return null;
        },
        (error: Error) => error,
      );
      const queuedB = queueGuard.acquireSlot({ scope: scopeB, timeoutMs: 1_000 }).then((lease) => {
        runBLease = lease;
      });

      expect(queueGuard.cancelRun(scopeA, 'run-a-cancelled')).toBe(0);
      await expect(queuedA).resolves.toMatchObject({
        message: expect.stringMatching(/cancelled.*run-a-cancelled/i),
      });
      expect(runAGranted).toBe(false);
      expect(queueGuard.getReservedCount(scopeB)).toBe(1);

      holder.release();
      await queuedB;
      expect(runBLease).toBeDefined();
      expect(runAGranted).toBe(false);
      runBLease?.release();
      expect(queueGuard.getReservedCount(scopeA)).toBe(0);
    });

    it('acquireSlot abort signal 会移除 waiter，释放容量后不会幽灵获批', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
      const holder = await queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 1_000 });
      const abortController = new AbortController();
      let cancelledWaiterGranted = false;
      const cancelledWaiter = queueGuard.acquireSlot({
        treeId: 'root',
        timeoutMs: 1_000,
        signal: abortController.signal,
      }).then(
        (lease) => {
          cancelledWaiterGranted = true;
          lease.release();
          return null;
        },
        (error: Error) => error,
      );

      abortController.abort('parent_cancelled');
      await expect(cancelledWaiter).resolves.toMatchObject({
        message: expect.stringMatching(/cancelled.*parent_cancelled/i),
      });
      holder.release();

      const nextLease = await queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 1_000 });
      expect(cancelledWaiterGranted).toBe(false);
      nextLease.release();
      expect(queueGuard.getReservedCount('root')).toBe(0);
    });

    it('acquireSlot 收到已 aborted signal 时立即拒绝且不占槽', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
      const abortController = new AbortController();
      abortController.abort('already_cancelled');

      await expect(queueGuard.acquireSlot({
        treeId: 'root',
        signal: abortController.signal,
      })).rejects.toThrow(/cancelled.*already_cancelled/i);
      expect(queueGuard.getReservedCount('root')).toBe(0);
      expect(queueGuard.canSpawn('root')).toBe(true);
    });

    it('cancelSession 只剔除目标 session 的 scoped 与 legacy queued waiters', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
      const scopeA: SwarmRunScope = {
        sessionId: 'session-a',
        runId: 'run-a',
        treeId: 'same-tree-label',
      };
      const scopeB: SwarmRunScope = {
        sessionId: 'session-b',
        runId: 'run-b',
        treeId: 'same-tree-label',
      };
      const activeAId = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
      const activeAController = new AbortController();
      queueGuard.register(
        activeAId,
        'coder',
        'active session A agent',
        new Promise<SubagentResult>(() => {}),
        activeAController,
        { scope: scopeA },
      );
      const holderB = await queueGuard.acquireSlot({ scope: scopeB });
      const legacyHolder = await queueGuard.acquireSlot({ treeId: scopeA.sessionId });
      const waiterA = queueGuard.acquireSlot({ scope: scopeA }).catch((error: Error) => error);
      const legacyWaiter = queueGuard.acquireSlot({ treeId: scopeA.sessionId }).catch((error: Error) => error);
      let waiterBLease: { release: () => void } | undefined;
      const waiterB = queueGuard.acquireSlot({ scope: scopeB }).then((lease) => {
        waiterBLease = lease;
      });

      expect(queueGuard.cancelSession(scopeA.sessionId, 'session-a-cancelled')).toBe(1);
      await expect(waiterA).resolves.toMatchObject({
        message: expect.stringMatching(/cancelled.*session-a-cancelled/i),
      });
      await expect(legacyWaiter).resolves.toMatchObject({
        message: expect.stringMatching(/cancelled.*session-a-cancelled/i),
      });
      expect(activeAController.signal.aborted).toBe(true);
      expect(queueGuard.getReservedCount(scopeA)).toBe(0);
      expect(queueGuard.getReservedCount(scopeB)).toBe(1);

      holderB.release();
      await waiterB;
      expect(waiterBLease).toBeDefined();
      waiterBLease?.release();
      legacyHolder.release();
      expect(queueGuard.getReservedCount(scopeA)).toBe(0);
      expect(queueGuard.getReservedCount(scopeB)).toBe(0);
      expect(queueGuard.getReservedCount(scopeA.sessionId)).toBe(0);
    });

    it('cancelAll 会剔除 scoped 与 legacy queued waiters', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
      const scope: SwarmRunScope = {
        sessionId: 'session-a',
        runId: 'run-a',
        treeId: 'tree-a',
      };
      const scopedController = new AbortController();
      const legacyController = new AbortController();
      queueGuard.register(
        createScopedSwarmAgentId(scope, 'agent_coder_0'),
        'coder',
        'scoped active agent',
        new Promise<SubagentResult>(() => {}),
        scopedController,
        { scope },
      );
      queueGuard.register(
        'legacy-agent',
        'coder',
        'legacy active agent',
        new Promise<SubagentResult>(() => {}),
        legacyController,
        { treeId: 'legacy-tree' },
      );
      const scopedWaiter = queueGuard.acquireSlot({ scope }).catch((error: Error) => error);
      const legacyWaiter = queueGuard.acquireSlot({ treeId: 'legacy-tree' }).catch((error: Error) => error);

      expect(queueGuard.cancelAll('app_shutdown')).toBe(2);
      await expect(scopedWaiter).resolves.toMatchObject({
        message: expect.stringMatching(/cancelled.*app_shutdown/i),
      });
      await expect(legacyWaiter).resolves.toMatchObject({
        message: expect.stringMatching(/cancelled.*app_shutdown/i),
      });
      expect(scopedController.signal.aborted).toBe(true);
      expect(legacyController.signal.aborted).toBe(true);

      expect(queueGuard.getReservedCount(scope)).toBe(0);
      expect(queueGuard.getReservedCount('legacy-tree')).toBe(0);
    });

    it('排队等待超时后返回明确错误', async () => {
      resetSpawnGuard();
      const queueGuard = getSpawnGuard({ maxAgents: 1 });
      const lease = await queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 1000 });

      await expect(
        queueGuard.acquireSlot({ treeId: 'root', timeoutMs: 5 }),
      ).rejects.toThrow(/timed out.*root.*max 1/i);

      lease.release();
    });

    it('cancel 运行中 agent 会释放 tree 槽位', () => {
      resetSpawnGuard();
      const cancelGuard = getSpawnGuard({ maxAgents: 1 });
      const pending = new Promise<SubagentResult>(() => {});
      cancelGuard.register('a1', 'coder', 't1', pending, new AbortController(), { treeId: 'root' });

      expect(cancelGuard.canSpawn('root')).toBe(false);
      expect(cancelGuard.cancel('a1')).toBe(true);
      expect(cancelGuard.canSpawn('root')).toBe(true);
      expect(cancelGuard.getReservedCount('root')).toBe(0);
    });
  });

  // ==========================================================================
  // 生命周期 & 自动状态转换
  // ==========================================================================

  describe('生命周期', () => {
    it('promise resolve(success=true) 将状态转为 completed 并记录 result', async () => {
      await registerSettled(
        guard,
        'a1',
        'coder',
        makeResult({ output: 'ok', iterations: 5 })
      );

      const a = guard.get('a1');
      expect(a?.status).toBe('completed');
      expect(a?.result?.output).toBe('ok');
      expect(a?.completedAt).toBeTypeOf('number');
    });

    it('promise resolve(success=false) 将状态转为 failed 并保留 error', async () => {
      await registerSettled(
        guard,
        'a1',
        'coder',
        makeResult({ success: false, error: 'tool error' })
      );

      const a = guard.get('a1');
      expect(a?.status).toBe('failed');
      expect(a?.error).toBe('tool error');
    });

    it('promise reject 将状态转为 failed 并记录异常 message', async () => {
      await registerRejected(guard, 'a1', 'coder', new Error('boom'));

      const a = guard.get('a1');
      expect(a?.status).toBe('failed');
      expect(a?.error).toBe('boom');
    });

    it('cancel 正在运行的 agent 触发 abort + 状态转 cancelled', () => {
      const pending = new Promise<SubagentResult>(() => {});
      const controller = new AbortController();
      guard.register('a1', 'coder', 't1', pending, controller);

      expect(guard.cancel('a1')).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(guard.get('a1')?.status).toBe('cancelled');
    });

    it('cancel 已完成的 agent 返回 false', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      expect(guard.cancel('a1')).toBe(false);
    });

    it('onComplete 回调在 agent 结束后触发', async () => {
      const cb = vi.fn();
      guard.onComplete(cb);

      await registerSettled(guard, 'a1', 'coder', makeResult());

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].id).toBe('a1');
    });

    it('onComplete 抛错不会影响其他回调', async () => {
      const good = vi.fn();
      guard.onComplete(() => {
        throw new Error('cb fail');
      });
      guard.onComplete(good);

      await registerSettled(guard, 'a1', 'coder', makeResult());

      expect(good).toHaveBeenCalledTimes(1);
    });

    it('waitFor 在全部完成后立即返回', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      await registerSettled(guard, 'a2', 'coder', makeResult());

      const map = await guard.waitFor(['a1', 'a2'], 1000);
      expect(map.size).toBe(2);
      expect(map.get('a1')?.status).toBe('completed');
      expect(map.get('a2')?.status).toBe('completed');
    });

    it('waitFor 超时后返回仍在 running 的 agent 当前快照', async () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());

      const map = await guard.waitFor(['a1'], 30);
      expect(map.get('a1')?.status).toBe('running');
    });
  });

  // ==========================================================================
  // 消息队列
  // ==========================================================================

  describe('消息队列', () => {
    beforeEach(() => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
    });

    it('sendMessage string 转为 text message 入队', () => {
      expect(guard.sendMessage('a1', 'hello')).toBe(true);
      const msgs = guard.drainMessages('a1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe('text');
      expect(msgs[0].payload).toBe('hello');
    });

    it('sendMessage 非 running agent 返回 false', async () => {
      await registerSettled(guard, 'a2', 'coder', makeResult());
      expect(guard.sendMessage('a2', 'late')).toBe(false);
    });

    it('sendStructuredMessage 按 type 入队', () => {
      guard.sendStructuredMessage('a1', 'shutdown_request', 'parent', {
        reason: 'done',
      });
      const msgs = guard.drainMessages('a1');
      expect(msgs[0].type).toBe('shutdown_request');
      expect(JSON.parse(msgs[0].payload)).toEqual({ reason: 'done' });
    });

    it('drainMessages 清空队列', () => {
      guard.sendMessage('a1', 'm1');
      guard.sendMessage('a1', 'm2');
      expect(guard.drainMessages('a1')).toHaveLength(2);
      expect(guard.drainMessages('a1')).toHaveLength(0);
    });

    it('drainMessagesByType 只抽取匹配类型，其余保留', () => {
      guard.sendMessage('a1', createTextMessage('parent', 'hi'));
      guard.sendMessage(
        'a1',
        createAgentMessage('shutdown_request', 'parent', { reason: 'stop' })
      );

      const shutdowns = guard.drainMessagesByType('a1', 'shutdown_request');
      expect(shutdowns).toHaveLength(1);
      expect(shutdowns[0].type).toBe('shutdown_request');

      const rest = guard.drainMessages('a1');
      expect(rest).toHaveLength(1);
      expect(rest[0].type).toBe('text');
    });
  });

  // ==========================================================================
  // 通知 + 依赖检查
  // ==========================================================================

  describe('通知与依赖', () => {
    it('agent 完成后 pendingNotifications 自动入队', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      const notes = guard.drainNotifications();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('<subagent_notification>');
      expect(notes[0]).toContain('"agent_id"');
      expect(notes[0]).toContain('a1');
    });

    it('drainNotifications 二次调用返回空', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      guard.drainNotifications();
      expect(guard.drainNotifications()).toEqual([]);
    });

    it('isTaskReady 在 blocker running 时返回 false', () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('blocker', 'coder', 't', pending, new AbortController());
      expect(guard.isTaskReady('child', new Set(['blocker']))).toBe(false);
    });

    it('isTaskReady 在所有 blocker 完成后返回 true', async () => {
      await registerSettled(guard, 'blocker', 'coder', makeResult());
      expect(guard.isTaskReady('child', new Set(['blocker']))).toBe(true);
    });
  });

  // ==========================================================================
  // 清理 + 工具黑名单
  // ==========================================================================

  describe('清理与工具黑名单', () => {
    it('cleanup 移除超期的完成态 agent', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult());
      const a = guard.get('a1');
      // Backdate createdAt so it's older than maxAge
      if (a) a.createdAt = Date.now() - 10_000;

      const removed = guard.cleanup(1_000);
      expect(removed).toBe(1);
      expect(guard.get('a1')).toBeUndefined();
    });

    it('cleanup 不会移除 running agent', () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 't1', pending, new AbortController());
      const a = guard.get('a1');
      if (a) a.createdAt = Date.now() - 10_000;

      expect(guard.cleanup(1_000)).toBe(0);
      expect(guard.get('a1')).toBeDefined();
    });

    it('getDisabledTools 放行 spawn 入口，但保留交互/编排控制禁用项', () => {
      const disabled = guard.getDisabledTools();
      expect(disabled).not.toContain('spawn_agent');
      expect(disabled).not.toContain('AgentSpawn');
      expect(disabled).not.toContain('Task');
      expect(disabled).toContain('workflow');
      expect(disabled).toContain('DynamicWorkflow');
      expect(disabled).toContain('workflow_orchestrate');
      expect(disabled).toContain('ask_user_question');
      expect(disabled).toContain('agent_message');
      expect(disabled).toContain('wait_agent');
      expect(disabled).toContain('close_agent');
      expect(disabled).toContain('send_input');
      expect(disabled).toContain('teammate');
      expect(disabled).toContain('plan_review');
    });

    it('getReadonlyDisabledTools 额外包含写入类工具', () => {
      const readonly = guard.getReadonlyDisabledTools();
      expect(readonly).toContain('Write');
      expect(readonly).toContain('Edit');
      // 仍然包含基础黑名单
      expect(readonly).toContain('workflow');
      expect(readonly).not.toContain('spawn_agent');
    });
  });

  // ==========================================================================
  // 持久化 & 恢复
  // ==========================================================================

  describe('持久化与恢复', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-guard-test-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('persistState 写入 JSON 并包含 agent 元数据', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult({ output: 'hi' }));
      guard.sendMessage('a1', 'queued-after-complete');

      await guard.persistState(tmpDir);

      const filePath = path.join(tmpDir, 'spawn-guard-state.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(raw.agents).toHaveLength(1);
      expect(raw.agents[0].id).toBe('a1');
      expect(raw.agents[0].status).toBe('completed');
      expect(raw.agents[0].recoveryPlan).toBeUndefined();
      expect(raw.pendingNotifications.length).toBeGreaterThan(0);
    });

    // SpawnGuard class is not exported; reach the static restoreState through
    // the constructor of a live instance.
    const getSpawnGuardCtor = (): {
      restoreState: (dir: string, scope?: SwarmRunScope) => Promise<Guard | null>;
    } => {
      const instance = getSpawnGuard();
      return instance.constructor as unknown as {
        restoreState: (dir: string, scope?: SwarmRunScope) => Promise<Guard | null>;
      };
    };

    it('persists and restores two same-role runs without overwriting inbox or records', async () => {
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
      const agentA = createScopedSwarmAgentId(scopeA, 'agent_coder_0');
      const agentB = createScopedSwarmAgentId(scopeB, 'agent_coder_0');
      const pending = new Promise<SubagentResult>(() => {});
      guard.register(agentA, 'coder', 'Team A', pending, new AbortController(), { scope: scopeA });
      guard.register(agentB, 'coder', 'Team B', pending, new AbortController(), { scope: scopeB });
      guard.sendMessage(agentA, 'inbox-a', scopeA);
      guard.sendMessage(agentB, 'inbox-b', scopeB);

      await Promise.all([
        guard.persistState(tmpDir, scopeA),
        guard.persistState(tmpDir, scopeB),
      ]);

      const files = fs.readdirSync(tmpDir).filter((file) => file.endsWith('.json'));
      expect(files).toHaveLength(2);
      expect(files.every((file) => /^spawn-guard-run-[a-f0-9]{32}\.json$/.test(file))).toBe(true);

      const SpawnGuardClass = getSpawnGuardCtor();
      const restoredA = await SpawnGuardClass.restoreState(tmpDir, scopeA);
      const restoredB = await SpawnGuardClass.restoreState(tmpDir, scopeB);
      expect(restoredA?.get(agentA, scopeA)?.status).toBe('dead-log-only');
      expect(restoredB?.get(agentB, scopeB)?.status).toBe('dead-log-only');
      expect(restoredA?.peekMessages(agentA, scopeA)[0]?.payload).toBe('inbox-a');
      expect(restoredB?.peekMessages(agentB, scopeB)[0]?.payload).toBe('inbox-b');
      expect(restoredA?.get(agentB, scopeB)).toBeUndefined();
      expect(restoredB?.get(agentA, scopeA)).toBeUndefined();

      guard.cancelRun(scopeA, 'test-cleanup');
      guard.cancelRun(scopeB, 'test-cleanup');
    });

    it('restoreState 将 running agent 标为 dead-log-only（进程重启中断但保留恢复态）', async () => {
      const pending = new Promise<SubagentResult>(() => {});
      guard.register('a1', 'coder', 'long-running', pending, new AbortController());

      await guard.persistState(tmpDir);

      const SpawnGuardClass = getSpawnGuardCtor();
      const restored = await SpawnGuardClass.restoreState(tmpDir);

      expect(restored).not.toBeNull();
      const a = restored!.get('a1');
      expect(a?.status).toBe('dead-log-only');
      expect(a?.error).toMatch(/log is available only/);
      expect(a?.recoveryPlan).toMatchObject({
        status: 'interrupted-by-restart',
        recoverable: false,
        recommendedActions: ['review_messages', 'restart_subagent_if_needed'],
      });
    });

    it('restoreState 给已完成 agent 补 before-restart 恢复语义', async () => {
      await registerSettled(guard, 'a1', 'coder', makeResult({ output: 'done' }));
      await guard.persistState(tmpDir);

      const SpawnGuardClass = getSpawnGuardCtor();
      const restored = await SpawnGuardClass.restoreState(tmpDir);

      expect(restored).not.toBeNull();
      const a = restored!.get('a1');
      expect(a?.status).toBe('completed');
      expect(a?.recoveryPlan).toMatchObject({
        status: 'completed-before-restart',
        recoverable: true,
        recommendedActions: ['review_result'],
      });
    });

    it('restoreState 对不存在的 state 文件返回 null', async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-guard-empty-'));
      try {
        const SpawnGuardClass = getSpawnGuardCtor();
        const restored = await SpawnGuardClass.restoreState(empty);
        expect(restored).toBeNull();
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });
});
