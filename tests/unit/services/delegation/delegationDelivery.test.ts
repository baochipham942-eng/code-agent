import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applyDurableRunMigrationDraft } from '../../../../src/host/services/core/database/migrations/durableRun';
import { QUEUED_INPUT_RETRY } from '../../../../src/shared/constants/queuedInput';
import { QueuedInputRepository } from '../../../../src/host/services/core/repositories/QueuedInputRepository';
import {
  SessionDelegationRepository,
} from '../../../../src/host/services/core/repositories/SessionDelegationRepository';
import {
  deriveActionFingerprint,
  deriveSubmissionKey,
} from '../../../../src/host/services/delegation/delegationKeys';
import {
  commitDelegation,
  collectDeliveryFacts,
  evaluateDelegationDelivery,
  projectTerminalDelegations,
  type DelegationDeliveryFactDependencies,
} from '../../../../src/host/services/delegation/delegationDelivery';
import type { DelegationSessionRowLike } from '../../../../src/host/services/delegation/delegationDelivery';

const schemaLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

function attachmentFixture(id: string, path: string) {
  return {
    id,
    path,
    name: `${id}.png`,
    type: 'image' as const,
    category: 'image' as const,
    mimeType: 'image/png',
    size: 42,
  };
}

interface TargetFacts {
  sessionType?: string;
  engineKind?: string;
  permissionMode?: string | null;
  folderTrustState?: string;
  blockedItems?: number;
  folderTrustError?: boolean;
  hasSessionRow?: boolean;
  activeRunId?: string | null;
  workingDirectory?: string;
}

describe('delegationDelivery（K1C 投递接缝）', () => {
  let db: BetterSqlite3.Database;
  let queuedInputs: QueuedInputRepository;
  let delegations: SessionDelegationRepository;

  const originSessionId = 'origin-1';
  const originTurnId = 'turn-1';
  const targetSessionId = 'target-1';
  const content = '把这份对比表补完';
  const submissionKey = deriveSubmissionKey({
    originSessionId,
    originTurnId,
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
  });
  const actionFingerprint = deriveActionFingerprint({
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
    content,
    attachmentRefs: [],
  });
  const queuedInputId = `delegation:${submissionKey}`;

  function makeDeps(facts: TargetFacts = {}): DelegationDeliveryFactDependencies {
    return {
      getDb: () => db,
      getSessionRow: (sessionId) => (facts.hasSessionRow === false && sessionId === targetSessionId
        ? null
        : {
          sessionType: facts.sessionType ?? 'chat',
          engineKind: facts.engineKind ?? 'native',
          workingDirectory: facts.workingDirectory ?? '/ws/target-1',
          isArchived: false,
          isDeleted: false,
        } satisfies DelegationSessionRowLike),
      getPermissionMode: () => facts.permissionMode ?? 'default',
      evaluateFolderTrust: async () => {
        if (facts.folderTrustError) throw new Error('trust scan failed');
        return { state: facts.folderTrustState ?? 'trusted', blockedItems: facts.blockedItems ?? 0 };
      },
      getActiveRunId: () => facts.activeRunId ?? null,
    };
  }

  function commitDefaults(now = 1_000): void {
    commitDelegation(db, {
      delegationId: 'd-1',
      originSessionId,
      originTurnId,
      disposition: 'delegate_existing',
      targetSessionId,
      submissionKey,
      actionFingerprint,
      envelope: { content, sessionId: targetSessionId },
      now,
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, schemaLogger);
    queuedInputs = new QueuedInputRepository(db);
    delegations = new SessionDelegationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('commitDelegation（单事务提交）', () => {
    it('created：委托行 + queued_inputs 行同事务落库，行 id 带 delegation: 前缀', () => {
      const result = commitDelegation(db, {
        delegationId: 'd-1',
        originSessionId,
        originTurnId,
        disposition: 'delegate_existing',
        targetSessionId,
        submissionKey,
        actionFingerprint,
        envelope: { content, sessionId: targetSessionId },
        now: 1_000,
      });
      expect(result).toEqual({ kind: 'created', delegationId: 'd-1', queuedInputId });

      const delegation = delegations.get('d-1');
      expect(delegation).toMatchObject({
        status: 'active',
        targetQueuedInputId: queuedInputId,
        submissionKey,
        actionFingerprint,
      });
      const row = queuedInputs.getById(queuedInputId);
      expect(row).toMatchObject({ sessionId: targetSessionId, status: 'queued', position: 0 });
      // envelope 落库时带上带外标记
      expect(JSON.parse(row!.envelopeJson).context.delegationOrigin)
        .toEqual({ delegationId: 'd-1', actionFingerprint });
    });

    it('排在已有输入之后（position = MAX+1，不插队）', () => {
      queuedInputs.enqueue({ id: 'user-1', sessionId: targetSessionId, envelope: { content: '先来的' }, now: 100 });
      commitDefaults();
      expect(queuedInputs.getById(queuedInputId)?.position).toBe(1);
    });

    it('同输入重放返回 reused 且不重复入队（只一行 queued）', () => {
      commitDefaults(1_000);
      const replay = commitDelegation(db, {
        delegationId: 'd-other',
        originSessionId,
        originTurnId,
        disposition: 'delegate_existing',
        targetSessionId,
        submissionKey,
        actionFingerprint,
        envelope: { content, sessionId: targetSessionId },
        now: 2_000,
      });
      expect(replay).toEqual({ kind: 'reused', delegationId: 'd-1', queuedInputId });
      expect(delegations.get('d-other')).toBeNull();
      expect(queuedInputs.listBySession(targetSessionId)).toHaveLength(1);
    });

    it('writeSessionRow 抛错 → 委托行与排队行都不可见（事务性）', () => {
      expect(() => commitDelegation(db, {
        delegationId: 'd-1',
        originSessionId,
        originTurnId,
        disposition: 'create_new',
        targetSessionId: 'new-session',
        submissionKey,
        actionFingerprint,
        envelope: { content, sessionId: 'new-session' },
        now: 1_000,
      }, () => {
        throw new Error('session row write failed');
      })).toThrow('session row write failed');
      expect(delegations.get('d-1')).toBeNull();
      expect(queuedInputs.getById(queuedInputId)).toBeNull();
    });

    it('writeSessionRow 正常时三者同事务可见', () => {
      let wroteSession = false;
      commitDelegation(db, {
        delegationId: 'd-1',
        originSessionId,
        originTurnId,
        disposition: 'create_new',
        targetSessionId: 'new-session',
        submissionKey,
        actionFingerprint,
        envelope: { content, sessionId: 'new-session' },
        now: 1_000,
      }, () => {
        wroteSession = true;
      });
      expect(wroteSession).toBe(true);
      expect(delegations.get('d-1')).not.toBeNull();
      expect(queuedInputs.getById(queuedInputId)).not.toBeNull();
    });

    it('同键异指纹 → idempotency_conflict，且不落第二条', () => {
      commitDefaults();
      const conflict = commitDelegation(db, {
        delegationId: 'd-2',
        originSessionId,
        originTurnId,
        disposition: 'delegate_existing',
        targetSessionId,
        submissionKey,
        actionFingerprint: 'f'.repeat(64),
        envelope: { content: '改过的正文', sessionId: targetSessionId },
        now: 2_000,
      });
      expect(conflict.kind).toBe('idempotency_conflict');
      expect(delegations.get('d-2')).toBeNull();
    });
  });

  describe('evaluateDelegationDelivery（INV-1/INV-5 复核缝）', () => {
    it('无委托行的 id → 按普通用户消息投（不带标记）', async () => {
      queuedInputs.enqueue({ id: 'plain-user-row', sessionId: targetSessionId, envelope: { content }, now: 100 });
      const decision = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById('plain-user-row')!);
      expect(decision).toEqual({ kind: 'deliver' });
    });

    it('委托行 + 指纹对上 + 空闲 → deliver 且带校验过的标记', async () => {
      commitDefaults();
      const decision = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(decision).toEqual({
        kind: 'deliver',
        delegationId: 'd-1',
        delegationOrigin: { delegationId: 'd-1', actionFingerprint },
      });
    });

    it('载荷被改（指纹对不上）→ pause payload_mismatch，改过的载荷不投出去', async () => {
      commitDefaults();
      queuedInputs.updateEnvelope(queuedInputId, JSON.stringify({ content: '被改过的正文', sessionId: targetSessionId }), 2_000);
      const decision = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(decision).toMatchObject({ kind: 'pause', code: 'payload_mismatch' });
    });

    it('附件引用变化也算指纹不符（INV-5 覆盖附件 id/路径）', async () => {
      const fingerprintWithAttachment = deriveActionFingerprint({
        action: 'delegate_existing',
        targetIdentity: `session:${targetSessionId}`,
        content,
        attachmentRefs: [{ id: 'att-1', path: '/tmp/a.png' }],
      });
      commitDelegation(db, {
        delegationId: 'd-1', originSessionId, originTurnId,
        disposition: 'delegate_existing', targetSessionId,
        submissionKey, actionFingerprint: fingerprintWithAttachment,
        envelope: { content, sessionId: targetSessionId, attachments: [attachmentFixture('att-1', '/tmp/a.png')] },
        now: 1_000,
      });
      const decision = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(decision).toMatchObject({ kind: 'deliver' });

      queuedInputs.updateEnvelope(queuedInputId, JSON.stringify({
        content, sessionId: targetSessionId, attachments: [attachmentFixture('att-1', '/tmp/b.png')],
      }), 2_000);
      const mismatch = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(mismatch).toMatchObject({ kind: 'pause', code: 'payload_mismatch' });
    });

    it('另一条委托占着的 run → wait（排队不是冲突）', async () => {
      commitDefaults();
      // 另一条委托 d-2 已在该目标上起轮并回填了 run id
      delegations.insertOrGet({
        delegationId: 'd-2',
        originSessionId: 'origin-2',
        originTurnId: 'turn-2',
        disposition: 'delegate_existing',
        targetSessionId,
        targetQueuedInputId: 'delegation:sdk-other',
        submissionKey: 'sdk-other',
        actionFingerprint: 'a'.repeat(64),
        createdAt: 1_500,
      });
      delegations.backfillTargetRunId('d-2', 'run-d-2');
      const decision = await evaluateDelegationDelivery(makeDeps({ activeRunId: 'run-d-2' }), queuedInputs.getById(queuedInputId)!);
      expect(decision).toEqual({ kind: 'wait' });
    });

    it('对不上委托行的活跃 run → pause target_busy', async () => {
      commitDefaults();
      expect(await evaluateDelegationDelivery(makeDeps({ activeRunId: 'run-user' }), queuedInputs.getById(queuedInputId)!))
        .toMatchObject({ kind: 'pause', code: 'target_busy' });
    });

    it('排在本行之前的用户来源可投行 → pause target_busy', async () => {
      queuedInputs.enqueue({ id: 'user-ahead', sessionId: targetSessionId, envelope: { content: '排在前面的用户行' }, now: 90 });
      commitDefaults();
      const ahead = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(ahead).toMatchObject({ kind: 'pause', code: 'target_busy' });
    });

    it('已暂停的用户行在前不计入（只数可投/发送中的用户行）', async () => {
      commitDefaults();
      queuedInputs.enqueue({ id: 'user-paused', sessionId: targetSessionId, envelope: { content: '暂停的用户行' }, now: 500 });
      queuedInputs.pauseQueued('user-paused', 'send_failed', 600);
      const decision = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(decision).toMatchObject({ kind: 'deliver', delegationId: 'd-1' });
    });

    it('排在后面的用户行不算忙', async () => {
      commitDefaults();
      queuedInputs.enqueue({ id: 'user-behind', sessionId: targetSessionId, envelope: { content: '排在后面' }, now: 2_000 });
      const decision = await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!);
      expect(decision).toMatchObject({ kind: 'deliver' });
    });

    it('复核侧门红 → 对应 pause 码（权限档/信任/目标失格）', async () => {
      commitDefaults();
      expect(await evaluateDelegationDelivery(makeDeps({ permissionMode: 'bypassPermissions' }), queuedInputs.getById(queuedInputId)!))
        .toMatchObject({ kind: 'pause', code: 'target_permission_mode' });
      expect(await evaluateDelegationDelivery(makeDeps({ folderTrustError: true }), queuedInputs.getById(queuedInputId)!))
        .toMatchObject({ kind: 'pause', code: 'untrusted_workspace' });
      expect(await evaluateDelegationDelivery(makeDeps({ engineKind: 'grok_cli' }), queuedInputs.getById(queuedInputId)!))
        .toMatchObject({ kind: 'pause', code: 'not_delegatable' });
    });

    it('rework r1：stop 落在 sending 期间，run 普通失败回队后 → pause delegation_stopped，不自动重投', async () => {
      commitDefaults();
      // 复盘评审场景：委托 run 在跑（行 sending）→ stop 的 pauseQueued 够不着 →
      // run 碰一次普通失败（如 429）→ requeueAfterFailure 回 queued 且清空暂停
      expect(queuedInputs.markSending(queuedInputId, 1_500)).toBe(true);
      expect(delegations.markStopped('d-1', { reason: 'user' }, 1_600)).toBe(1);
      expect(queuedInputs.requeueAfterFailure(queuedInputId, 1_700)).toEqual({ retryCount: 1 });
      const row = queuedInputs.getById(queuedInputId)!;
      expect(row.status).toBe('queued');
      expect(row.pausedReason).toBeNull();
      // 复核必须挡下：stopped 委托不得经 drain 自动重试路径带着标记重投
      expect(await evaluateDelegationDelivery(makeDeps(), row))
        .toMatchObject({ kind: 'pause', code: 'delegation_stopped' });
    });

    it('rework r1：superseded / aborted(retracted_by_user) / terminal_observed → pause delegation_inactive', async () => {
      const finalize: Array<(id: string) => unknown> = [
        (id) => delegations.markSuperseded(id, 1_600),
        (id) => delegations.markAborted(id, 'retracted_by_user', 1_600),
        (id) => {
          delegations.backfillTargetRunId(id, `run-${id}`);
          return delegations.markTerminalObserved(id, 1_600);
        },
      ];
      for (let i = 0; i < finalize.length; i += 1) {
        const rowId = `delegation:inactive-case-${i}`;
        queuedInputs.enqueue({ id: rowId, sessionId: targetSessionId, envelope: { content }, now: 100 });
        delegations.insertOrGet({
          delegationId: `d-inactive-${i}`,
          originSessionId,
          originTurnId,
          disposition: 'delegate_existing',
          targetSessionId,
          targetQueuedInputId: rowId,
          submissionKey: `sdk-inactive-${i}`,
          actionFingerprint,
          createdAt: 1_000,
        });
        finalize[i](`d-inactive-${i}`);
        expect(await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(rowId)!))
          .toMatchObject({ kind: 'pause', code: 'delegation_inactive' });
      }
    });

    it('rework r1：aborted(delivery_failed) 仍可投（INV-6 重发复活不受生命周期门影响）', async () => {
      commitDefaults();
      expect(delegations.markAborted('d-1', 'delivery_failed', 1_500)).toBe(1);
      expect(await evaluateDelegationDelivery(makeDeps(), queuedInputs.getById(queuedInputId)!))
        .toMatchObject({ kind: 'deliver', delegationId: 'd-1' });
    });
  });

  describe('collectDeliveryFacts（K1D 复用的事实收集）', () => {
    it('收集委托行、run id、delegatedRunIds 与 userRowsAhead', async () => {
      commitDefaults();
      delegations.backfillTargetRunId('d-1', 'run-d-1');
      const facts = await collectDeliveryFacts(makeDeps({ activeRunId: 'run-d-1' }), {
        sessionId: targetSessionId,
        queuedInputId,
        originSessionId,
      });
      expect(facts.delegation?.delegationId).toBe('d-1');
      expect(facts.snapshot.activeRunId).toBe('run-d-1');
      expect(facts.snapshot.delegatedRunIds).toContain('run-d-1');
      expect(facts.snapshot.userRowsAhead).toBe(0);
    });
  });

  describe('projectTerminalDelegations（终态投影）', () => {
    it('目标 run 终态 → terminal_observed（幂等，重复投影不重写 resolved_at）', async () => {
      commitDefaults();
      delegations.backfillTargetRunId('d-1', 'run-d-1');
      const observed = await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-d-1', status: 'completed' }),
        now: 5_000,
      });
      expect(observed).toBe(1);
      expect(delegations.get('d-1')).toMatchObject({ status: 'terminal_observed', resolvedAt: 5_000 });

      const again = await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-d-1', status: 'completed' }),
        now: 9_000,
      });
      expect(again).toBe(0);
      expect(delegations.get('d-1')?.resolvedAt).toBe(5_000);
    });

    it('非终态 run 不写；run 行缺失不写；按会话过滤', async () => {
      commitDefaults();
      delegations.backfillTargetRunId('d-1', 'run-d-1');
      expect(await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-d-1', status: 'running' }),
        now: 5_000,
      })).toBe(0);
      expect(await projectTerminalDelegations(db, { getRun: async () => null, now: 5_000 })).toBe(0);
      expect(await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-d-1', status: 'failed' }),
        now: 5_000,
        targetSessionId: 'another-session',
      })).toBe(0);
      expect(delegations.get('d-1')?.status).toBe('active');
    });

    it('getRun 缺省走真实 DurableRunRepository', async () => {
      applyDurableRunMigrationDraft(db);
      commitDefaults();
      delegations.backfillTargetRunId('d-1', 'run-d-1');
      db.prepare(`INSERT INTO durable_runs (
          run_id, session_id, engine_kind, status, attempt, next_event_seq, checkpoint_seq,
          envelope_json, terminal_event_seq, terminal_at, created_at, updated_at
        ) VALUES (?, ?, 'native', 'cancelled', 1, 1, 0, ?, 1, 1, ?, ?)`)
        .run('run-d-1', targetSessionId, JSON.stringify({
          runId: 'run-d-1',
          sessionId: targetSessionId,
          status: 'cancelled',
          engine: { kind: 'native' },
          cursor: { nextEventSeq: 0, checkpointSeq: 0 },
          createdAt: 1,
          updatedAt: 1,
        }), 1, 1);
      expect(await projectTerminalDelegations(db, { now: 5_000 })).toBe(1);
      expect(delegations.get('d-1')?.status).toBe('terminal_observed');
    });

    it('rework r8：run A 正常完成 → terminal_observed 照写（正常路径不变）', async () => {
      commitDefaults();
      expect(queuedInputs.markSending(queuedInputId, 1_500)).toBe(true);
      expect(delegations.backfillTargetRunId('d-1', 'run-a')).toBe(1);
      expect(queuedInputs.markConsumed(queuedInputId, 1_600)).toBe(true);
      const observed = await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-a', status: 'completed' }),
        now: 5_000,
      });
      expect(observed).toBe(1);
      expect(delegations.get('d-1'))
        .toMatchObject({ status: 'terminal_observed', resolvedAt: 5_000, targetRunId: 'run-a' });
    });

    it('rework r8：run 被取消（stop 路径）→ 即使行停在重试态也照写 terminal_observed', async () => {
      commitDefaults();
      expect(queuedInputs.markSending(queuedInputId, 1_500)).toBe(true);
      expect(delegations.backfillTargetRunId('d-1', 'run-a')).toBe(1);
      // stop 处理器形状：行带原因回 queued + markStopped，run 被 cancel
      expect(queuedInputs.pauseAfterClaim(queuedInputId, 'delegation_stopped', 1_600)).toBe(true);
      expect(delegations.markStopped('d-1', { reason: 'user' }, 1_600)).toBe(1);
      const observed = await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-a', status: 'cancelled' }),
        now: 5_000,
      });
      expect(observed).toBe(1);
      expect(delegations.get('d-1')?.status).toBe('terminal_observed');
    });
  });

  describe('createDelegationDrainHooks（真实钩子）', () => {
    it('onActivated：active 行回填 run id；aborted(delivery_failed) 行翻回 active 改记新 run', async () => {
      const { createDelegationDrainHooks } = await import('../../../../src/host/services/delegation/delegationDrainHooks');
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const hooks = createDelegationDrainHooks({ ...makeDeps(), logger });
      commitDefaults();
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-first' });
      expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetRunId: 'run-first' });

      // 重试耗尽 → aborted(delivery_failed) → 同行重发起新轮 → 翻回 active 记新 run
      delegations.markAborted('d-1', 'delivery_failed', 3_000);
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-second' });
      expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetRunId: 'run-second' });
    });

    it('rework r7：stop→resume 后 onActivated 记新 run；旧 run 终态不投影、新 run 进 delegatedRunIds（INV-4/G10）', async () => {
      const { createDelegationDrainHooks } = await import('../../../../src/host/services/delegation/delegationDrainHooks');
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const hooks = createDelegationDrainHooks({ ...makeDeps(), logger });
      commitDefaults();
      // 首次投递：激活回填 run A（排队行仍 queued，停/复用同一批仓储调用）。
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-a' });
      expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetRunId: 'run-a' });

      // stop（与 delegateSession 的 stop 处理器同形状：暂停排队行 + markStopped）
      expect(queuedInputs.pauseQueued(queuedInputId, 'delegation_stopped', 2_000)).toBe(true);
      expect(delegations.markStopped('d-1', { reason: 'user' }, 2_000)).toBe(1);

      // resume（与 resume 处理器同形状：unpauseQueued + markResumed）——
      // markResumed 必须清掉指向已取消旧 run 的 target_run_id，否则
      // backfillTargetRunId 的 only-fill-when-NULL 守卫会让新 run 的回填静默落空。
      expect(queuedInputs.unpauseQueued(queuedInputId, 2_500)).toBe(true);
      expect(delegations.markResumed('d-1', 2_500)).toBe(1);
      expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetRunId: null });

      // 再次投递：onActivated 带新 run B —— 回填必须真的写进去
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-b' });
      expect(delegations.get('d-1')?.targetRunId).toBe('run-b');

      // 旧 run A 已终态（cancelled）：投影不得据此把还在跑的委托标成 terminal_observed
      const observed = await projectTerminalDelegations(db, {
        getRun: async (runId) => ({ runId, status: runId === 'run-a' ? 'cancelled' : 'running' }),
        now: 3_000,
      });
      expect(observed).toBe(0);
      expect(delegations.get('d-1')?.status).toBe('active');

      // 新 run B 必须在 delegatedRunIds 里（G10：活跃 run 对不上任何委托 → 误判用户来源/target_busy）
      const facts = await collectDeliveryFacts(makeDeps({ activeRunId: 'run-b' }), {
        sessionId: targetSessionId,
        queuedInputId,
        originSessionId,
      });
      expect(facts.snapshot.delegatedRunIds).toContain('run-b');
      expect(facts.snapshot.delegatedRunIds).not.toContain('run-a');
    });

    it('rework r8：run A 可重试失败 → 投影不写终态、委托保持 active，重投回填 run B（台账③）', async () => {
      const { createDelegationDrainHooks } = await import('../../../../src/host/services/delegation/delegationDrainHooks');
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const hooks = createDelegationDrainHooks({ ...makeDeps(), logger });
      commitDefaults();
      // 首次投递：抢占 → 激活回填 run A
      expect(queuedInputs.markSending(queuedInputId, 1_500)).toBe(true);
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-a' });
      expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetRunId: 'run-a' });

      // run A 一次可重试失败（瞬时 429/超时）→ drain settle：requeueAfterFailure 回 queued
      expect(queuedInputs.requeueAfterFailure(queuedInputId, 1_700)).toEqual({ retryCount: 1 });

      // drain finally 的终态投影看到 run A failed：对委托不是终态，不得写 terminal_observed
      const observed = await projectTerminalDelegations(db, {
        getRun: async (runId) => ({ runId, status: runId === 'run-a' ? 'failed' : 'running' }),
        now: 2_000,
      });
      expect(observed).toBe(0);
      expect(delegations.get('d-1')).toMatchObject({ status: 'active', targetRunId: null });

      // 行未被生命周期门暂停（delegation_inactive），下一次 drain 会投它
      const row = queuedInputs.getById(queuedInputId)!;
      expect(row).toMatchObject({ status: 'queued', pausedReason: null });
      expect(queuedInputs.getNextDispatchable(targetSessionId)?.id).toBe(queuedInputId);
      expect(await evaluateDelegationDelivery(makeDeps(), row))
        .toMatchObject({ kind: 'deliver', delegationId: 'd-1' });

      // 重投激活 run B → 回填记新 run（INV-4：翻回/保持 active 并改记新 run）
      expect(queuedInputs.markSending(queuedInputId, 1_800)).toBe(true);
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-b' });
      expect(delegations.get('d-1')?.targetRunId).toBe('run-b');
    });

    it('rework r8：重试耗尽 → aborted(delivery_failed)，行不可再投（终态归 onRetryExhausted）', async () => {
      const { createDelegationDrainHooks } = await import('../../../../src/host/services/delegation/delegationDrainHooks');
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const hooks = createDelegationDrainHooks({ ...makeDeps(), logger });
      commitDefaults();
      expect(queuedInputs.markSending(queuedInputId, 1_500)).toBe(true);
      hooks.onActivated({ id: queuedInputId, sessionId: targetSessionId }, { runId: 'run-a' });

      // 与 drain settleRunFailure 同形状：每次失败 requeue 回 queued；超预算 → markFailed + onRetryExhausted
      let exhausted = false;
      for (let attempt = 1; attempt <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1; attempt += 1) {
        if (attempt > 1) expect(queuedInputs.markSending(queuedInputId, 2_000 + attempt)).toBe(true);
        const requeued = queuedInputs.requeueAfterFailure(queuedInputId, 2_100 + attempt);
        expect(requeued).not.toBeNull();
        if (requeued!.retryCount > QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS) {
          expect(queuedInputs.markFailed(queuedInputId, 2_900)).toBe(true);
          hooks.onRetryExhausted({ id: queuedInputId, sessionId: targetSessionId });
          exhausted = true;
        }
      }
      expect(exhausted).toBe(true);
      expect(delegations.get('d-1')).toMatchObject({ status: 'aborted' });
      expect(JSON.parse(delegations.get('d-1')!.resolutionJson!)).toEqual({ reason: 'delivery_failed' });
      // 行不可再投（failed + send_failed 不进 getNextDispatchable）
      expect(queuedInputs.getNextDispatchable(targetSessionId)).toBeNull();
      // 耗尽后的投影对 aborted 行是 no-op
      expect(await projectTerminalDelegations(db, {
        getRun: async () => ({ runId: 'run-a', status: 'failed' }),
        now: 3_000,
      })).toBe(0);
      expect(delegations.get('d-1')?.status).toBe('aborted');
    });

    it('onClaimConflict：sending 行 pauseAfterClaim(target_busy)；onRetryExhausted：投影 aborted(delivery_failed)', async () => {
      const { createDelegationDrainHooks } = await import('../../../../src/host/services/delegation/delegationDrainHooks');
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const hooks = createDelegationDrainHooks({ ...makeDeps(), logger });
      commitDefaults();
      queuedInputs.markSending(queuedInputId, 2_000);
      hooks.onClaimConflict({ id: queuedInputId, sessionId: targetSessionId });
      expect(queuedInputs.getById(queuedInputId)).toMatchObject({ status: 'queued', pausedReason: 'target_busy' });

      queuedInputs.markSending(queuedInputId, 2_500);
      hooks.onRetryExhausted({ id: queuedInputId, sessionId: targetSessionId });
      expect(delegations.get('d-1')).toMatchObject({ status: 'aborted' });
      expect(JSON.parse(delegations.get('d-1')!.resolutionJson!)).toEqual({ reason: 'delivery_failed' });
    });
  });

  it('oracle mint：工具引擎侧 orchestrator 起源铸币函数（K1C 带外标记消费方）', async () => {
    const { mintDelegatedTurnOrigin, mintUserTurnOrigin } = await import('../../../../src/host/agent/messageOrigin');
    expect(mintDelegatedTurnOrigin({ sessionId: 's', runId: 'r', turnId: 't' }))
      .toEqual([{ senderKind: 'orchestrator', sessionId: 's', runId: 'r', turnId: 't' }]);
    expect(mintUserTurnOrigin({ sessionId: 's' })).toEqual([{ senderKind: 'user', sessionId: 's' }]);
  });
});
