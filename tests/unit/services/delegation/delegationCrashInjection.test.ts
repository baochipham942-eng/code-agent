// ============================================================================
// E3 崩溃注入（ADR-072 D5.1 / K1C，fault-injection 档）——确定性单测：
// 真内存库 + 真仓储 + 真 createWebQueuedInputDrain + 真委托钩子/守卫，
// 只 fake runEnvelope。
// 点1（提交后、抢占前崩溃）：行不被旧 drain 带走；新 drain 启动扫恰投一次；
//      同输入重放 reused，不重复入队。
// 点2（抢占后、轮返回前崩溃）：sending 孤儿复位 queued+restart，启动扫自动补投 0，
//      行不删、委托行仍 active；解停只经复核后的 sendNow（recheck 先于抢占）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { QueuedInputRepository } from '../../../../src/host/services/core/repositories/QueuedInputRepository';
import { SessionDelegationRepository } from '../../../../src/host/services/core/repositories/SessionDelegationRepository';
import { commitDelegation } from '../../../../src/host/services/delegation/delegationDelivery';
import {
  createDelegationDrainHooks,
  createQueuedInputDelegationGuard,
} from '../../../../src/host/services/delegation/delegationDrainHooks';
import {
  deriveActionFingerprint,
  deriveSubmissionKey,
} from '../../../../src/host/services/delegation/delegationKeys';
import { createWebQueuedInputDrain } from '../../../../src/web/routes/webQueuedInputDrain';
import { registerQueuedInputHandlers } from '../../../../src/host/ipc/queuedInput.ipc';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../../src/shared/ipc';
import type { WebRouteHandler } from '../../../../src/web/routes/routeTypes';

const schemaLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

const SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** seed → 前排用户行数（抢占顺序在委托行之前）/ 后排用户行数。 */
function rowsAround(seed: number): { ahead: number; behind: number } {
  return { ahead: seed % 4, behind: (seed * 2) % 3 };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Harness {
  db: BetterSqlite3.Database;
  queuedInputs: QueuedInputRepository;
  delegations: SessionDelegationRepository;
  delegationQueuedInputId: string;
  activeRunId: string | null;
  /** 真钩子（createDelegationDrainHooks）+ 可控事实依赖（不碰真实 folderTrust）。 */
  deps: Parameters<typeof createDelegationDrainHooks>[0];
  commit(now?: number): { kind: string };
  enqueueUsers(ahead: number, behind: number): void;
}

function buildHarness(seed: number): Harness {
  const db = new Database(':memory:');
  applySchema(db, schemaLogger);
  const queuedInputs = new QueuedInputRepository(db);
  const delegations = new SessionDelegationRepository(db);
  const targetSessionId = 'target-session';
  const content = `委托正文 seed-${seed}`;
  const submissionKey = deriveSubmissionKey({
    originSessionId: 'origin-1',
    originTurnId: 'turn-1',
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
  }) + `-s${seed}`;
  const actionFingerprint = deriveActionFingerprint({
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
    content,
    attachmentRefs: [],
  });
  const state: { activeRunId: string | null } = { activeRunId: null };
  const harness: Harness = {
    db,
    queuedInputs,
    delegations,
    delegationQueuedInputId: `delegation:${submissionKey}`,
    get activeRunId() {
      return state.activeRunId;
    },
    set activeRunId(value: string | null) {
      state.activeRunId = value;
    },
    deps: {
      getDb: () => db,
      getSessionRow: () => ({
        sessionType: 'chat',
        engineKind: 'native',
        workingDirectory: '/ws/target',
        isArchived: false,
        isDeleted: false,
      }),
      getPermissionMode: () => 'default',
      evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      getActiveRunId: () => state.activeRunId,
      getRun: async () => null,
      logger,
    },
    commit: (now = 1_000) => commitDelegation(db, {
      delegationId: 'd-1',
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      disposition: 'delegate_existing',
      targetSessionId,
      submissionKey,
      actionFingerprint,
      envelope: { content, sessionId: targetSessionId },
      now,
    }),
    enqueueUsers: (ahead: number, behind: number) => {
    for (let index = 0; index < ahead; index += 1) {
      queuedInputs.enqueue({
        id: `user-ahead-${index}`,
        sessionId: targetSessionId,
        envelope: { content: `ahead-${index}` },
        now: 100 + index,
      });
    }
    for (let index = 0; index < behind; index += 1) {
      queuedInputs.enqueue({
        id: `user-behind-${index}`,
        sessionId: targetSessionId,
        envelope: { content: `behind-${index}` },
        now: 5_000 + index,
      });
    }
  },
  };
  return harness;
}

interface DrainCall {
  clientMessageId: string | undefined;
  delegationOrigin: unknown;
}

/**
 * 真 drain + fake runEnvelope。resolve 时按真实运行时那样触发
 * handleReleasedSession（releaseThenTriggerWebQueuedInputDrain），排队行才会级联抽干；
 * onActivated 对委托行回填（真钩子 → backfillTargetRunId）。
 */
function makeDrain(input: {
  harness: Harness;
  calls: DrainCall[];
  neverResolve?: boolean;
}): ReturnType<typeof createWebQueuedInputDrain> {
  const { harness, calls } = input;
  const hooks = createDelegationDrainHooks(harness.deps);
  let handle: ReturnType<typeof createWebQueuedInputDrain>;
  handle = createWebQueuedInputDrain({
    getRepository: () => new QueuedInputRepository(harness.db),
    hasActiveRun: () => false,
    runEnvelope: async (envelope, _response, onActivated, options) => {
      calls.push({ clientMessageId: envelope.clientMessageId, delegationOrigin: options?.delegationOrigin });
      if (input.neverResolve) {
        // 点2：抢占后、run 返回前进程消失——这个 promise 永远不结算。
        await new Promise<void>(() => {});
      }
      if (envelope.clientMessageId === harness.delegationQueuedInputId) {
        onActivated({ runId: `run-${envelope.clientMessageId}`, activatedAt: 4_242 });
      }
      // 真实 runtime 在 run 收尾释放会话后触发下一轮 drain。
      queueMicrotask(() => handle.handleReleasedSession(envelope.sessionId!));
    },
    emitAgentEvent: () => {},
    notifyQueuedInputSettled: () => {},
    notifyQueuedInputActivated: () => {},
    delegation: hooks,
    logger,
  });
  return handle;
}

describe('delegation 崩溃注入（E3 · ADR-072 K1C · fault-injection）', () => {
  let db: BetterSqlite3.Database | null = null;

  afterEach(() => {
    databaseState.db = null;
    db?.close();
    db = null;
    vi.restoreAllMocks();
  });

  describe.each(SEEDS)('点1：提交后、抢占前崩溃（seed %i）', (seed) => {
    it('旧 drain 未抽走行；新 drain 启动扫恰投一次；重放 reused 不重复入队', async () => {
      const { ahead, behind } = rowsAround(seed);
      const harness = buildHarness(seed);
      db = harness.db;
      databaseState.db = harness.db;
      harness.enqueueUsers(ahead, 0);
      expect(harness.commit().kind).toBe('created');
      harness.enqueueUsers(0, behind);

      // 崩溃：drain A 建好但一次都没触发（通知未到达即消失）。
      const drainACalls: DrainCall[] = [];
      const drainA = makeDrain({ harness, calls: drainACalls });
      void drainA;
      expect(drainACalls).toHaveLength(0);

      // 重启：新 drain B 启动扫。
      const drainBCalls: DrainCall[] = [];
      const drainB = makeDrain({ harness, calls: drainBCalls });
      drainB.runStartupSweep();

      const total = ahead + 1 + behind;
      await vi.waitFor(() => {
        expect(harness.queuedInputs.listBySession('target-session')
          .filter((row) => row.status === 'consumed')).toHaveLength(total);
      }, { timeout: 3_000 });

      // 恰投一次：委托行一次（带校验过的带外标记），每条用户行也各一次。
      const delegationCalls = drainBCalls.filter((call) => call.clientMessageId === harness.delegationQueuedInputId);
      expect(delegationCalls).toHaveLength(1);
      expect(delegationCalls[0].delegationOrigin).toMatchObject({ delegationId: 'd-1' });
      const userCalls = drainBCalls.filter((call) => call.clientMessageId !== harness.delegationQueuedInputId);
      expect(userCalls).toHaveLength(ahead + behind);

      // INV-4：投递激活回填 target_run_id。
      expect(harness.delegations.get('d-1')).toMatchObject({
        status: 'active',
        targetRunId: `run-${harness.delegationQueuedInputId}`,
      });

      // 崩溃重放：同输入重投 → reused，不重复入队。
      const replay = harness.commit(9_000);
      expect(replay.kind).toBe('reused');
      const rowsWithId = harness.db
        .prepare('SELECT COUNT(*) AS count FROM queued_inputs WHERE id = ?')
        .get(harness.delegationQueuedInputId) as { count: number };
      expect(rowsWithId.count).toBe(1);
    });
  });

  describe.each(SEEDS)('点2：抢占后、轮返回前崩溃（seed %i）', (seed) => {
    it('sending 孤儿复位 queued+restart，启动扫自动补投 0，委托仍 active；解停只经复核后的 sendNow', async () => {
      const { ahead, behind } = rowsAround(seed);
      const harness = buildHarness(seed);
      db = harness.db;
      databaseState.db = harness.db;
      // 前排用户行在崩溃前已被消费（确定性：委托行就是本轮被抢占的那条）。
      harness.enqueueUsers(ahead, 0);
      for (let index = 0; index < ahead; index += 1) {
        harness.queuedInputs.markSending(`user-ahead-${index}`, 200);
        harness.queuedInputs.markConsumed(`user-ahead-${index}`, 300);
      }
      expect(harness.commit().kind).toBe('created');
      harness.enqueueUsers(0, behind);

      // drain A 抢占委托行后 run 永不返回。
      const drainACalls: DrainCall[] = [];
      const drainA = makeDrain({ harness, calls: drainACalls, neverResolve: true });
      drainA.handleEnqueued('target-session');
      await vi.waitFor(() => {
        expect(harness.queuedInputs.getById(harness.delegationQueuedInputId)?.status).toBe('sending');
      }, { timeout: 3_000 });
      expect(drainACalls).toHaveLength(1);

      // 崩溃：丢弃 drain A（pending runEnvelope 永不结算）。重启：drain B 启动扫。
      const drainBCalls: DrainCall[] = [];
      const drainB = makeDrain({ harness, calls: drainBCalls });
      drainB.runStartupSweep();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const row = harness.queuedInputs.getById(harness.delegationQueuedInputId);
      expect(row).toMatchObject({ status: 'queued', pausedReason: 'restart' });
      expect(drainBCalls.filter((call) => call.clientMessageId === harness.delegationQueuedInputId)).toHaveLength(0);
      expect(row).not.toBeNull();
      expect(harness.delegations.get('d-1')?.status).toBe('active');

      // 解停只经复核后的 sendNow：IPC 守卫先复核再抢占（调用顺序断言）。
      const claimOrder: string[] = [];
      const originalMarkSending = QueuedInputRepository.prototype.markSending;
      vi.spyOn(QueuedInputRepository.prototype, 'markSending')
        .mockImplementation(function (this: QueuedInputRepository, id: string, now?: number) {
          claimOrder.push('markSending');
          return originalMarkSending.call(this, id, now);
        });
      const baseGuard = createQueuedInputDelegationGuard(harness.deps);
      const ipcHandlers = new Map<string, WebRouteHandler>();
      registerQueuedInputHandlers({
        handle: (channel: string, handler: WebRouteHandler) => ipcHandlers.set(channel, handler),
      } as never, {
        hasActiveRun: () => false,
        sendNow: async () => 'sent',
        delegation: {
          ...baseGuard,
          async beforeSendNowClaim(record) {
            claimOrder.push('recheck');
            return baseGuard.beforeSendNowClaim(record);
          },
        },
      });
      const invoke = async (request: IPCRequest): Promise<IPCResponse> =>
        (await ipcHandlers.get(IPC_DOMAINS.QUEUED_INPUT)!(null, request)) as IPCResponse;

      await expect(invoke({ action: 'sendNow', payload: { id: harness.delegationQueuedInputId } }))
        .resolves.toMatchObject({ success: true, data: { status: 'consumed' } });
      expect(claimOrder).toEqual(['recheck', 'markSending']);
    });
  });
});
