// ============================================================================
// delegationDelivery — commit seam + delivery re-check + terminal projection
// for cross-session delegation (ADR-072 D5/D5.1, slice K1C)
// ============================================================================
// Pure判定在 delegationAdmission/delegationKeys（K1B）；这里收集事实、
// 落库、并把复核结果翻译成排队行的投递决策。不打开第二个恢复状态机：
// 投递主人仍是 createWebQueuedInputDrain / sendNow。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { ConversationEnvelope } from '../../../shared/contract/conversationEnvelope';
import type { DelegationOriginMarker } from '../../../shared/contract/queuedInput';
import { isTerminalRunStatus } from '../../../shared/contract/durableRun';
import { QueuedInputRepository } from '../core/repositories/QueuedInputRepository';
import {
  SessionDelegationRepository,
  type SessionDelegationDisposition,
  type SessionDelegationRecord,
} from '../core/repositories/SessionDelegationRepository';
import { DurableRunRepository } from '../core/repositories/DurableRunRepository';
import {
  attachmentRefsOf,
  deriveActionFingerprint,
} from './delegationKeys';
import {
  recheckForDelivery,
  type DelegationDeliverySnapshot,
} from './delegationAdmission';

const DELEGATION_QUEUE_ID_PREFIX = 'delegation:';

function delegationQueuedInputId(submissionKey: string): string {
  return DELEGATION_QUEUE_ID_PREFIX + submissionKey;
}

export interface CommitDelegationInput {
  delegationId: string;
  originSessionId: string;
  originTurnId: string;
  disposition: SessionDelegationDisposition;
  targetSessionId: string;
  submissionKey: string;
  actionFingerprint: string;
  supersedesDelegationId?: string | null;
  /** 完整 envelope（content/attachments）；modelSpec 由调用方按目标档位盖好。 */
  envelope: ConversationEnvelope;
  now: number;
}

export interface CommitDelegationSupersede {
  supersededDelegationId: string;
  retractQueuedInputId?: string | null;
}

export type CommitDelegationResult =
  | { kind: 'created'; delegationId: string; queuedInputId: string }
  | { kind: 'reused'; delegationId: string; queuedInputId: string }
  | { kind: 'idempotency_conflict'; delegationId: string; queuedInputId: string };

/**
 * 单事务提交边界（D5.1）：先判幂等键写入 session_delegations 行（带
 * target_queued_input_id），仅 created 时写入 create_new 的 sessions 行（由 K1D
 * 传 sessionManager options.commit 的写回调）并 enqueue queued_inputs 行。
 * 任一步抛错三者都不可见。id = 'delegation:' + submission_key，INSERT OR IGNORE
 * 主键幂等，崩溃重放不重复入队；提交后由调用方（K1D）通知 drain。
 */
export function commitDelegation(
  db: BetterSqlite3.Database,
  input: CommitDelegationInput,
  writeSessionRow?: () => void,
  supersede?: CommitDelegationSupersede,
): CommitDelegationResult {
  const queuedInputId = delegationQueuedInputId(input.submissionKey);
  const envelope: ConversationEnvelope = {
    ...input.envelope,
    context: {
      ...(input.envelope.context ?? {}),
      delegationOrigin: {
        delegationId: input.delegationId,
        actionFingerprint: input.actionFingerprint,
      },
    },
  };

  const run = db.transaction((): CommitDelegationResult => {
    const delegations = new SessionDelegationRepository(db);
    const inserted = delegations.insertOrGet({
      delegationId: input.delegationId,
      originSessionId: input.originSessionId,
      originTurnId: input.originTurnId,
      disposition: input.disposition,
      targetSessionId: input.targetSessionId,
      targetQueuedInputId: queuedInputId,
      submissionKey: input.submissionKey,
      actionFingerprint: input.actionFingerprint,
      supersedesDelegationId: input.supersedesDelegationId ?? null,
      createdAt: input.now,
    });
    if (inserted.kind === 'created') {
      writeSessionRow?.();
      new QueuedInputRepository(db).enqueue({
        id: queuedInputId,
        sessionId: input.targetSessionId,
        envelope,
        now: input.now,
      });
      if (supersede?.retractQueuedInputId) {
        new QueuedInputRepository(db).retract(supersede.retractQueuedInputId, input.now);
      }
      if (supersede) {
        delegations.markSuperseded(supersede.supersededDelegationId, input.now);
      }
    }
    return { kind: inserted.kind, delegationId: inserted.record.delegationId, queuedInputId };
  });
  return run();
}

// ---------------------------------------------------------------------------
// 事实收集（K1D 的 delegate_session 与 K1C 的投递复核共用）
// ---------------------------------------------------------------------------

/** 会话行事实的最小投影（StoredSession / Session 都满足）。 */
export interface DelegationSessionRowLike {
  sessionType?: string;
  engineKind?: string;
  workingDirectory?: string | null;
  isArchived?: boolean;
  isDeleted?: boolean;
}

export interface DelegationDeliveryFactDependencies {
  getDb(): BetterSqlite3.Database | null;
  getSessionRow(sessionId: string): DelegationSessionRowLike | null;
  /** 生效权限档（getPermissionModeManager().getModeForSession）。 */
  getPermissionMode(sessionId: string): string | null;
  /** evaluateFolderTrust；抛错由这里兜成 {error:true}。 */
  evaluateFolderTrust(workingDirectory: string): Promise<{ state: string; blockedItems: number }>;
  /** 活跃 run id（runRegistry.getBySessionId(...)?.context.runId）。 */
  getActiveRunId(sessionId: string): string | null;
}

function sessionTargetSnapshot(
  session: DelegationSessionRowLike | null,
  permissionMode: string | null,
  folderTrust: DelegationDeliverySnapshot['target']['folderTrust'],
): DelegationDeliverySnapshot['target'] {
  return {
    sessionId: null,
    sessionExists: session !== null,
    isArchived: session?.isArchived === true,
    isDeleted: session?.isDeleted === true,
    sessionType: session?.sessionType ?? 'chat',
    engineKind: session?.engineKind ?? 'native',
    workspaceRoot: session?.workingDirectory?.trim() || null,
    workspaceAuthorized: true,
    permissionMode,
    folderTrust,
  };
}

export interface DelegationDeliveryFacts {
  delegation: SessionDelegationRecord | null;
  snapshot: DelegationDeliverySnapshot;
}

/**
 * 收集投递复核事实（INV-2）。K1D 的提案门与这里的差别只在占用口径：
 * 这里 userRowsAhead 只数排在本行之前、用户来源、queued 且可投或 sending 的行
 * （已暂停的用户行不计入）。
 */
export async function collectDeliveryFacts(
  deps: DelegationDeliveryFactDependencies,
  target: { sessionId: string; queuedInputId: string; originSessionId: string | null },
): Promise<DelegationDeliveryFacts> {
  const db = deps.getDb();
  const session = deps.getSessionRow(target.sessionId);
  const permissionMode = deps.getPermissionMode(target.sessionId);
  const workspaceRoot = session?.workingDirectory?.trim() || null;

  let folderTrust: DelegationDeliverySnapshot['target']['folderTrust'] = null;
  if (workspaceRoot) {
    try {
      folderTrust = await deps.evaluateFolderTrust(workspaceRoot);
    } catch {
      folderTrust = { error: true };
    }
  }

  const delegations = db ? new SessionDelegationRepository(db) : null;
  const delegation = delegations?.getByTargetQueuedInputId(target.queuedInputId) ?? null;
  const targetRows = delegations?.listByTargetSession(target.sessionId) ?? [];
  const delegatedRunIds = targetRows
    .map((row) => row.targetRunId)
    .filter((runId): runId is string => typeof runId === 'string');

  let userRowsAhead = 0;
  if (db) {
    const queuedInputs = new QueuedInputRepository(db);
    const record = queuedInputs.getById(target.queuedInputId);
    if (record) {
      const rowsAhead = queuedInputs
        .listBySession(target.sessionId)
        .filter((row) =>
          (row.position < record.position
            || (row.position === record.position && row.createdAt < record.createdAt)
            || (row.position === record.position && row.createdAt === record.createdAt && row.id < record.id))
          && row.id !== record.id);
      userRowsAhead = rowsAhead.filter((row) => {
        const dispatchable = row.status === 'queued' && row.pausedReason === null;
        const sending = row.status === 'sending';
        if (!dispatchable && !sending) return false;
        return delegations?.getByTargetQueuedInputId(row.id) === null;
      }).length;
    }
  }

  return {
    delegation,
    snapshot: {
      target: sessionTargetSnapshot(session, permissionMode, folderTrust),
      originSessionId: target.originSessionId ?? delegation?.originSessionId ?? null,
      activeRunId: deps.getActiveRunId(target.sessionId),
      delegatedRunIds,
      userRowsAhead,
    },
  };
}

// ---------------------------------------------------------------------------
// 投递复核（drain beforeClaim 与 IPC sendNow 共用同一条缝）
// ---------------------------------------------------------------------------

export type DelegationClaimDecision =
  | { kind: 'deliver'; delegationOrigin?: DelegationOriginMarker; delegationId?: string }
  | { kind: 'wait' }
  | { kind: 'pause'; code: string; detail?: string };

function envelopeOf(record: { envelopeJson: string }): ConversationEnvelope | null {
  try {
    const parsed = JSON.parse(record.envelopeJson) as ConversationEnvelope;
    return typeof parsed?.content === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** aborted(delivery_failed) 是唯一可再投的 aborted 形态（INV-6 重发复活）。 */
export function isDeliveryFailedAbort(row: SessionDelegationRecord): boolean {
  if (row.status !== 'aborted' || !row.resolutionJson) return false;
  try {
    return (JSON.parse(row.resolutionJson) as { reason?: string }).reason === 'delivery_failed';
  } catch {
    return false;
  }
}

/**
 * 一条排队行的投递决策：无委托行 → 按普通用户消息投（不带标记，N2 剥除后投出）；
 * 有委托行 → 生命周期门（只有 active 与 aborted(delivery_failed) 可投）→ INV-5
 * 指纹比对（不符 → pause payload_mismatch，改过的载荷不投出去）
 * → collectDeliveryFacts + recheckForDelivery（INV-1：必须在 markSending 之前调）。
 */
export async function evaluateDelegationDelivery(
  deps: DelegationDeliveryFactDependencies,
  record: { id: string; sessionId: string; envelopeJson: string },
): Promise<DelegationClaimDecision> {
  const db = deps.getDb();
  const delegations = db ? new SessionDelegationRepository(db) : null;
  const delegation = delegations?.getByTargetQueuedInputId(record.id) ?? null;
  if (!delegation) {
    return { kind: 'deliver' };
  }

  // 生命周期门（rework r1）：stop/correct 落在 sending 期间时 pauseQueued/retract
  // 都够不着排队行，run 普通失败经 requeueAfterFailure 回到 queued 之后，这里是
  // 不让 stopped/superseded 委托被自动重投的最后一道门；stopped 用与 stop 处理器
  // 相同的暂停码，resume 复核通过后 unpause 复活。
  if (delegation.status !== 'active' && !isDeliveryFailedAbort(delegation)) {
    return delegation.status === 'stopped'
      ? { kind: 'pause', code: 'delegation_stopped', detail: 'delegation is stopped; resume re-checks before delivery' }
      : { kind: 'pause', code: 'delegation_inactive', detail: `delegation status is ${delegation.status}; not deliverable` };
  }

  const envelope = envelopeOf(record);
  const session = deps.getSessionRow(record.sessionId);
  // create_new 的指纹身份 = new:<新会话工作区根>（K1D 建会话时 workingDirectory
  // 就是 hostWorkspaceRoot）；delegate_existing = session:<目标 id>。
  const targetIdentity = delegation.disposition === 'create_new'
    ? `new:${session?.workingDirectory?.trim() ?? ''}`
    : `session:${record.sessionId}`;
  const derivedFingerprint = envelope
    ? deriveActionFingerprint({
      action: delegation.disposition,
      targetIdentity,
      content: envelope.content,
      attachmentRefs: attachmentRefsOf(envelope.attachments as never),
    })
    : null;
  if (derivedFingerprint !== delegation.actionFingerprint) {
    return {
      kind: 'pause',
      code: 'payload_mismatch',
      detail: 'stored payload does not match the delegation action fingerprint (INV-5)',
    };
  }

  const facts = await collectDeliveryFacts(deps, {
    sessionId: record.sessionId,
    queuedInputId: record.id,
    originSessionId: delegation.originSessionId,
  });
  const decision = recheckForDelivery(facts.snapshot);
  if (decision.kind === 'deliver') {
    return {
      kind: 'deliver',
      delegationId: delegation.delegationId,
      delegationOrigin: {
        delegationId: delegation.delegationId,
        actionFingerprint: delegation.actionFingerprint,
      },
    };
  }
  if (decision.kind === 'wait') {
    return { kind: 'wait' };
  }
  return { kind: 'pause', code: decision.code, detail: decision.detail };
}

// ---------------------------------------------------------------------------
// 终态投影（幂等；启动扫补写）
// ---------------------------------------------------------------------------

/** durable run 的最小投影（DurableRunRepository.get 的返回满足）。 */
export interface DelegationRunLike {
  runId: string;
  status: string;
}

/**
 * 投影看到目标 run 终态 → markTerminalObserved（幂等、可重放）。
 * run 行消失/读失败不写（下次投影再试），不把 RunStatus 复制进委托行。
 */
export async function projectTerminalDelegations(
  db: BetterSqlite3.Database,
  input: {
    getRun?: (runId: string) => Promise<DelegationRunLike | null>;
    now: number;
    targetSessionId?: string;
  },
): Promise<number> {
  const delegations = new SessionDelegationRepository(db);
  const runs = new DurableRunRepository(db);
  const getRun = input.getRun ?? ((runId: string) => runs.get(runId));
  const pending = delegations.listPendingTerminalObservation(input.targetSessionId);
  let observed = 0;
  for (const row of pending) {
    if (!row.targetRunId) continue;
    let run: DelegationRunLike | null;
    try {
      run = await getRun(row.targetRunId);
    } catch {
      run = null;
    }
    if (run && isTerminalRunStatus(run.status as never)) {
      observed += delegations.markTerminalObserved(row.delegationId, input.now);
    }
  }
  return observed;
}
