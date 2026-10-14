// ============================================================================
// delegationDrainHooks — wire the K1B pure admission functions into the real
// drain / IPC delivery paths (ADR-072 D5.1, slice K1C)
// ============================================================================
// agent.ts 的 drain 装配与 queuedInput.ipc 的 sendNow 守卫各拿一个工厂结果；
// 复核判定本身在 delegationDelivery.evaluateDelegationDelivery（单一接缝，
// 两条投递路径同一条 INV-1 规矩：先复核再 markSending）。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { ConversationEnvelopeContext } from '../../../shared/contract/conversationEnvelope';
import { QueuedInputRepository } from '../core/repositories/QueuedInputRepository';
import {
  SessionDelegationRepository,
} from '../core/repositories/SessionDelegationRepository';
import { getDatabase } from '../core/databaseService';
import { getPermissionModeManager } from '../../permissions/modes';
import { evaluateFolderTrust } from '../../security/folderTrustService';
import {
  evaluateDelegationDelivery,
  isDeliveryFailedAbort,
  projectTerminalDelegations,
  type DelegationClaimDecision,
  type DelegationRunLike,
  type DelegationSessionRowLike,
} from './delegationDelivery';

export interface DelegationRuntimeLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

/** 事实收集依赖（collectDeliveryFacts / evaluateDelegationDelivery 的输入）。 */
export interface DelegationRuntimeDependencies {
  getDb(): BetterSqlite3.Database | null;
  getSessionRow(sessionId: string): DelegationSessionRowLike | null;
  getPermissionMode(sessionId: string): string | null;
  evaluateFolderTrust(workingDirectory: string): Promise<{ state: string; blockedItems: number }>;
  getActiveRunId(sessionId: string): string | null;
  getRun?(runId: string): Promise<DelegationRunLike | null>;
  logger: DelegationRuntimeLogger;
}

/**
 * 生产装配：除活跃 run 与日志外全部取真实宿主服务。读库/读档失败一律走
 * fail-closed 形状（会话行 null → G1 拒；权限档异常 → 'unresolved' → G11 拒；
 * folderTrust 抛错在 collectDeliveryFacts 里兜成 {error:true} → G12 拒），
 * 不静默降级成「看起来可投」。
 */
export function createHostDelegationRuntime(input: {
  getActiveRunId(sessionId: string): string | null;
  logger: DelegationRuntimeLogger;
}): DelegationRuntimeDependencies {
  return {
    getDb: () => {
      try {
        return getDatabase().getDb();
      } catch {
        return null;
      }
    },
    getSessionRow: (sessionId) => {
      try {
        const session = getDatabase().getSession(sessionId);
        return session
          ? {
            sessionType: session.type,
            engineKind: session.engine?.kind,
            workingDirectory: session.workingDirectory ?? null,
            isArchived: session.isArchived,
            isDeleted: session.isDeleted,
          }
          : null;
      } catch {
        return null;
      }
    },
    getPermissionMode: (sessionId) => {
      try {
        return getPermissionModeManager().getModeForSession(sessionId);
      } catch {
        return 'unresolved';
      }
    },
    evaluateFolderTrust: async (workingDirectory) => {
      const evaluation = await evaluateFolderTrust(workingDirectory);
      return { state: evaluation.state, blockedItems: evaluation.blockedItems.length };
    },
    getActiveRunId: input.getActiveRunId,
    logger: input.logger,
  };
}

/** drain 的可选 delegation 钩子面（缺省 = 现行为，K1C 起生产装配注入）。 */
export interface DelegationDrainHooks {
  /** INV-1：必须在任何投递路径抢占（markSending）之前调用。 */
  beforeClaim(record: { id: string; sessionId: string; envelopeJson: string }): Promise<DelegationClaimDecision>;
  /** INV-4：把本次激活 run id 回填进委托行；aborted(delivery_failed) 行翻回 active。 */
  onActivated(record: { id: string; sessionId: string }, activation: { runId: string }): void;
  /** 抢占后撞 RunSessionConflictError：pauseAfterClaim(target_busy)，不进自动重试。 */
  onClaimConflict(record: { id: string; sessionId: string }): void;
  /** 重试耗尽 markFailed 之后：委托行投影 aborted(delivery_failed)。 */
  onRetryExhausted(record: { id: string; sessionId: string }): void;
  /** 终态投影（一轮结束后按会话；启动扫不传会话全量补写），幂等。 */
  projectTerminal(sessionId?: string): void;
}

/**
 * 投影类钩子（回填/暂停投影/撤回投影）失败不炸宿主流程：这些钩子跑在
 * runAgentTurn 的激活点、drain 收尾与 IPC 结算路径上，throw 会把已经合法
 * 起跑的 run / 已成功的撤回整个打死（错题本：fail-open 不等于失败不留痕）
 * ——warn 带可区分原因。
 */
function safeProject(
  deps: DelegationRuntimeDependencies,
  action: string,
  record: unknown,
  run: () => void,
): void {
  try {
    run();
  } catch (error) {
    deps.logger.warn(`Delegation hook failed: ${action}`, { record, error });
  }
}

export function createDelegationDrainHooks(deps: DelegationRuntimeDependencies): DelegationDrainHooks {
  return {
    async beforeClaim(record) {
      return evaluateDelegationDelivery(deps, record);
    },
    onActivated(record, activation) {
      safeProject(deps, 'onActivated', record, () => {
        const db = deps.getDb();
        if (!db) return;
        const delegations = new SessionDelegationRepository(db);
        const delegation = delegations.getByTargetQueuedInputId(record.id);
        if (!delegation) return;
        if (isDeliveryFailedAbort(delegation)) {
          delegations.reviveAfterResend(delegation.delegationId, activation.runId, Date.now());
          return;
        }
        delegations.backfillTargetRunId(delegation.delegationId, activation.runId);
      });
    },
    onClaimConflict(record) {
      safeProject(deps, 'onClaimConflict', record, () => {
        const db = deps.getDb();
        if (!db) return;
        if (!new QueuedInputRepository(db).pauseAfterClaim(record.id, 'target_busy')) {
          deps.logger.warn('Delegation row could not pause after claim conflict', record);
        }
      });
    },
    onRetryExhausted(record) {
      safeProject(deps, 'onRetryExhausted', record, () => {
        const db = deps.getDb();
        if (!db) return;
        const delegations = new SessionDelegationRepository(db);
        const delegation = delegations.getByTargetQueuedInputId(record.id);
        if (!delegation) return;
        delegations.markAborted(delegation.delegationId, 'delivery_failed', Date.now());
      });
    },
    projectTerminal(sessionId) {
      const db = deps.getDb();
      if (!db) return;
      void projectTerminalDelegations(db, {
        ...(deps.getRun ? { getRun: deps.getRun } : {}),
        now: Date.now(),
        ...(sessionId ? { targetSessionId: sessionId } : {}),
      }).catch((error: unknown) => {
        deps.logger.warn('Delegation terminal projection failed', { sessionId, error });
      });
    },
  };
}

/** queuedInput IPC 的委托守卫（update 拒改 / requeue 规则 / sendNow 先复核再抢占）。 */
export interface QueuedInputDelegationGuard {
  isDelegationRow(id: string): boolean;
  beforeSendNowClaim(record: { id: string; sessionId: string; envelopeJson: string }): Promise<DelegationClaimDecision>;
  /** retract 成功后的投影：aborted(retracted_by_user)，不可再翻回。 */
  onRetracted(record: { id: string; sessionId: string }): void;
}

export function createQueuedInputDelegationGuard(
  deps: DelegationRuntimeDependencies,
): QueuedInputDelegationGuard {
  return {
    isDelegationRow(id) {
      const db = deps.getDb();
      return db ? new SessionDelegationRepository(db).getByTargetQueuedInputId(id) !== null : false;
    },
    async beforeSendNowClaim(record) {
      return evaluateDelegationDelivery(deps, record);
    },
    onRetracted(record) {
      safeProject(deps, 'onRetracted', record, () => {
        const db = deps.getDb();
        if (!db) return;
        const delegations = new SessionDelegationRepository(db);
        const delegation = delegations.getByTargetQueuedInputId(record.id);
        if (delegation) {
          delegations.markAborted(delegation.delegationId, 'retracted_by_user', Date.now());
        }
      });
    },
  };
}

/**
 * N2 带外标记的剥除点：buildQueuedAgentRunBody 与 /run 入口一律剥掉客户端带来的
 * context.delegationOrigin——renderer/直调 HTTP 都不是权威，权威只有
 * session_delegations 行 + 指纹校验后的带外 transport。
 */
export function stripDelegationOriginContext<T extends ConversationEnvelopeContext>(context: T): T {
  if (!('delegationOrigin' in context) || context.delegationOrigin === undefined) return context;
  const { delegationOrigin: _untrusted, ...rest } = context;
  return rest as T;
}
