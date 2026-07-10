// ============================================================================
// Plan Approval Gate - 跨 Agent 审批机制
// ============================================================================
// 高风险操作前，子 Agent 提交 plan → Coordinator 审批 → 通过后才执行。
//
// 触发条件（仅高风险）：
// - 文件删除（rm -rf, rmdir）
// - 破坏性 bash 命令（isDangerousCommand）
// - 写入工作目录之外
// 低风险操作自动批准。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { isDangerousCommand } from '../services/core/permissionPresets';
import { getTeammateService } from './teammate/teammateService';
import { getEventBus } from '../services/eventing/bus';
import {
  createScopedSwarmAgentId,
  getSwarmRunScopeKey,
  isSameSwarmRun,
  parseScopedSwarmAgentId,
  type SwarmAgentRef,
  type SwarmEvent,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import type { ToolExecutionRequest } from './subagentPipeline';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';

/**
 * ADR-008 Phase 3: 通过 EventBus 发布 plan review 事件
 * 替代原 `import { getSwarmEventEmitter } from '../ipc/swarm.ipc'`，断开 Cycle 2 的反向边。
 * swarm.ipc 的 bridge 订阅器（ensureSwarmBusBridge）会把事件投递给渲染进程 + CLI listeners。
 */
function publishSwarmEvent(scope: SwarmRunScope, event: Omit<SwarmEvent, keyof SwarmRunScope>): void {
  const scopedEvent: SwarmEvent = { ...event, ...scope };
  const busType = event.type.startsWith('swarm:') ? event.type.slice(6) : event.type;
  getEventBus().publish('swarm', busType, scopedEvent, {
    sessionId: scope.sessionId,
    bridgeToRenderer: false,
  });
}

const logger = createLogger('PlanApprovalGate');

// ============================================================================
// Types
// ============================================================================

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

export interface PlanSubmission {
  id: string;
  agentId: string;
  agentName: string;
  coordinatorId: string;
  plan: string;
  risk: RiskAssessment;
  submittedAt: number;
  status: 'pending' | 'approved' | 'rejected';
  feedback?: string;
  resolvedAt?: number;
  scope?: SwarmRunScope;
}

export interface PlanSubmissionInput {
  agentId: string;
  agentName: string;
  coordinatorId: string;
  plan: string;
  risk: RiskAssessment;
  scope?: SwarmRunScope;
  signal?: AbortSignal;
}

export interface PlanApprovalResult {
  approved: boolean;
  feedback?: string;
  autoApproved: boolean;
}

// ============================================================================
// PlanApprovalGate
// ============================================================================

export class PlanApprovalGate {
  private pendingPlans: Map<string, PlanSubmission> = new Map();
  private planCounter = 0;
  /** Serial within one run, independent across concurrent Teams. */
  private approvalQueues = new Map<string, Promise<void>>();
  private approvalQueueScopes = new Map<string, SwarmRunScope>();
  private cancelledRunReasons = new Map<string, string>();
  private cancelAllReason: string | null = null;
  /** Resolvers for in-flight waitForApproval promises (event-driven wake-up) */
  private pendingResolvers: Map<string, (result: PlanApprovalResult) => void> = new Map();
  /** Default timeout for coordinator response (30 seconds) */
  private approvalTimeoutMs: number;
  /**
   * 持久化仓库（ADR-010 #2）。null 表示 DB 未就绪 / 测试不需要持久化，
   * 此时所有写入路径退化为纯内存模式。
   */
  private persistRepo: PendingApprovalRepository | null = null;

  constructor(options?: { approvalTimeoutMs?: number }) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 30_000;
  }

  /**
   * 注入持久化 repo，并 hydrate 上次进程崩溃残留的 pending 行。
   * 残留行会被打成 'orphaned' 状态写回内存 Map（不挂 resolver），
   * coordinator 通过 getPendingPlans() 仍能看到它们的存在并显式处理。
   */
  attachPersistence(repo: PendingApprovalRepository, now: number = Date.now()): number {
    this.persistRepo = repo;
    let hydrated = 0;
    try {
      const orphans = repo.markPendingAsOrphaned('plan', now);
      for (const row of orphans) {
        if (row.kind !== 'plan') continue;
        try {
          const submission = JSON.parse(row.payloadJson) as PlanSubmission;
          submission.status = 'rejected';
          submission.feedback = row.feedback ?? 'Orphaned by process restart';
          submission.resolvedAt = row.resolvedAt ?? now;
          this.pendingPlans.set(submission.id, submission);
          hydrated += 1;
        } catch (err) {
          logger.warn(`Failed to hydrate orphaned plan ${row.id}`, err);
        }
      }
      if (hydrated > 0) {
        logger.warn(`Hydrated ${hydrated} orphaned plan approval(s) from previous process`);
      }
    } catch (err) {
      logger.error('attachPersistence: failed to hydrate orphaned plans', err);
    }
    return hydrated;
  }

  private safePersistInsert(submission: PlanSubmission): void {
    if (!this.persistRepo) return;
    try {
      this.persistRepo.insert({
        id: submission.id,
        kind: 'plan',
        agentId: submission.agentId,
        agentName: submission.agentName,
        coordinatorId: submission.coordinatorId,
        payload: submission,
        submittedAt: submission.submittedAt,
      });
    } catch (err) {
      logger.warn(`PendingApproval insert failed for ${submission.id}`, err);
    }
  }

  private safePersistResolve(
    id: string,
    status: 'approved' | 'rejected',
    feedback: string | null,
    resolvedAt: number,
  ): void {
    if (!this.persistRepo) return;
    try {
      this.persistRepo.resolve({ id, status, feedback, resolvedAt });
    } catch (err) {
      logger.warn(`PendingApproval resolve failed for ${id}`, err);
    }
  }

  // --------------------------------------------------------------------------
  // Risk Assessment
  // --------------------------------------------------------------------------

  /**
   * Assess the risk level of a tool execution request.
   */
  assessRisk(request: ToolExecutionRequest, workingDirectory?: string): RiskAssessment {
    const reasons: string[] = [];

    // Check for dangerous bash commands
    if (request.command && isDangerousCommand(request.command)) {
      reasons.push(`Dangerous command: ${request.command}`);
    }

    // Check for file deletion patterns
    if (request.command) {
      if (/\brm\s+(-[rf]+\s+)/i.test(request.command)) {
        reasons.push('File deletion command');
      }
      if (/\brmdir\b/i.test(request.command)) {
        reasons.push('Directory removal');
      }
    }

    // Check for writes outside working directory
    if (workingDirectory && request.path) {
      if (!request.path.startsWith(workingDirectory)) {
        reasons.push(`Write outside working directory: ${request.path}`);
      }
    }

    // Determine risk level
    let level: RiskLevel = 'low';
    if (reasons.length >= 2) {
      level = 'high';
    } else if (reasons.length === 1) {
      level = 'medium';
    }

    return { level, reasons };
  }

  // --------------------------------------------------------------------------
  // Plan Submission & Approval
  // --------------------------------------------------------------------------

  /**
   * Submit a plan for approval.
   * Low-risk plans are auto-approved. High-risk plans wait for coordinator response.
   */
  async submitForApproval(params: PlanSubmissionInput): Promise<PlanApprovalResult> {
    // Low-risk: auto-approve
    if (params.risk.level === 'low') {
      logger.debug(`[${params.agentName}] Plan auto-approved (low risk)`);
      return { approved: true, autoApproved: true };
    }

    // Medium/High risk: submit and wait
    return this.enqueueApproval(params);
  }

  /**
   * Approve a pending plan.
   */
  approve(planId: string, feedback?: string, expected?: SwarmAgentRef): boolean {
    const plan = this.pendingPlans.get(planId);
    if (plan?.status !== 'pending') return false;
    if (expected && !this.matchesTarget(plan, expected)) return false;

    plan.status = 'approved';
    plan.feedback = feedback;
    plan.resolvedAt = Date.now();
    logger.info(`Plan approved: ${planId} for ${plan.agentName}`);
    this.safePersistResolve(planId, 'approved', feedback ?? null, plan.resolvedAt);
    this.publishPlanDecision(plan, 'approved', feedback);
    this.notifyPlanDecision(plan, true, feedback);

    // Event-driven wake-up: resolve the pending waitForApproval immediately
    const resolver = this.pendingResolvers.get(planId);
    if (resolver) {
      this.pendingResolvers.delete(planId);
      resolver({ approved: true, feedback, autoApproved: false });
    }
    return true;
  }

  /**
   * Reject a pending plan.
   */
  reject(planId: string, reason: string, expected?: SwarmAgentRef): boolean {
    const plan = this.pendingPlans.get(planId);
    if (plan?.status !== 'pending') return false;
    if (expected && !this.matchesTarget(plan, expected)) return false;

    plan.status = 'rejected';
    plan.feedback = reason;
    plan.resolvedAt = Date.now();
    logger.info(`Plan rejected: ${planId} for ${plan.agentName} — ${reason}`);
    this.safePersistResolve(planId, 'rejected', reason, plan.resolvedAt);
    this.publishPlanDecision(plan, 'rejected', reason);
    this.notifyPlanDecision(plan, false, reason);

    const resolver = this.pendingResolvers.get(planId);
    if (resolver) {
      this.pendingResolvers.delete(planId);
      resolver({ approved: false, feedback: reason, autoApproved: false });
    }
    return true;
  }

  /**
   * Cancel all pending plans with a common reason.
   * ADR-010 #6：swarm 取消或进程 shutdown 时排干 pendingResolvers，
   * 避免挂起的 submitForApproval promise 永远卡住等待 coordinator 响应。
   *
   * 返回被取消的 plan 数量。
   */
  cancelAll(reason: string): number {
    this.cancelAllReason = reason;
    if (this.pendingResolvers.size === 0) return 0;
    const feedback = `Cancelled: ${reason}`;
    let cancelled = 0;
    const now = Date.now();
    // 先快照 resolver list 再迭代，防止 resolver 触发 setter 改动原 Map
    const entries = Array.from(this.pendingResolvers.entries());
    this.pendingResolvers.clear();
    for (const [planId, resolver] of entries) {
      const plan = this.pendingPlans.get(planId);
      if (plan && plan.status === 'pending') {
        plan.status = 'rejected';
        plan.feedback = feedback;
        plan.resolvedAt = now;
        this.publishPlanDecision(plan, 'rejected', feedback);
        this.notifyPlanDecision(plan, false, feedback);
      }
      this.safePersistResolve(planId, 'rejected', feedback, now);
      try {
        resolver({ approved: false, feedback, autoApproved: true });
        cancelled += 1;
      } catch (err) {
        logger.warn(`Failed to resolve cancelled plan ${planId}`, err);
      }
    }
    logger.info(`Cancelled ${cancelled} pending plan approvals (${reason})`);
    return cancelled;
  }

  cancelRun(scope: SwarmRunScope, reason: string): number {
    // Record the tombstone even when the run has no current queue. A plan can
    // arrive after cancellation while an agent is unwinding; it must not open
    // a fresh approval queue for an already-cancelled Team.
    this.cancelledRunReasons.set(getSwarmRunScopeKey(scope), reason);
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [planId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const plan = this.pendingPlans.get(planId);
      if (!plan?.scope || !isSameSwarmRun(plan.scope, scope)) continue;

      this.pendingResolvers.delete(planId);
      plan.status = 'rejected';
      plan.feedback = feedback;
      plan.resolvedAt = now;
      this.safePersistResolve(planId, 'rejected', feedback, now);
      this.publishPlanDecision(plan, 'rejected', feedback);
      this.notifyPlanDecision(plan, false, feedback);
      resolver({ approved: false, feedback, autoApproved: true });
      cancelled += 1;
    }

    return cancelled;
  }

  /** Cancel only the pending plan owned by the exact scoped agent. */
  cancelAgent(ref: SwarmAgentRef, reason: string): number {
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [planId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const plan = this.pendingPlans.get(planId);
      if (!plan || !this.matchesTarget(plan, ref)) continue;

      this.pendingResolvers.delete(planId);
      plan.status = 'rejected';
      plan.feedback = feedback;
      plan.resolvedAt = now;
      this.safePersistResolve(planId, 'rejected', feedback, now);
      this.publishPlanDecision(plan, 'rejected', feedback);
      this.notifyPlanDecision(plan, false, feedback);
      resolver({ approved: false, feedback, autoApproved: true });
      cancelled += 1;
    }

    return cancelled;
  }

  /** Session cancellation drains the runs that exist now without poisoning future runs. */
  cancelSession(sessionId: string, reason: string): number {
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [queueKey, scope] of this.approvalQueueScopes) {
      if (scope.sessionId === sessionId) this.cancelledRunReasons.set(queueKey, reason);
    }

    for (const [planId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const plan = this.pendingPlans.get(planId);
      if (plan?.scope?.sessionId !== sessionId) continue;

      this.cancelledRunReasons.set(getSwarmRunScopeKey(plan.scope), reason);

      this.pendingResolvers.delete(planId);
      plan.status = 'rejected';
      plan.feedback = feedback;
      plan.resolvedAt = now;
      this.safePersistResolve(planId, 'rejected', feedback, now);
      this.publishPlanDecision(plan, 'rejected', feedback);
      this.notifyPlanDecision(plan, false, feedback);
      resolver({ approved: false, feedback, autoApproved: true });
      cancelled += 1;
    }

    return cancelled;
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  getPendingPlans(scope?: SwarmRunRef): PlanSubmission[] {
    return Array.from(this.pendingPlans.values())
      .filter((plan) => plan.status === 'pending')
      .filter((plan) => !scope || Boolean(plan.scope && isSameSwarmRun(plan.scope, scope)));
  }

  getPendingResolverCount(): number {
    return this.pendingResolvers.size;
  }

  getPlan(planId: string, expected?: SwarmAgentRef): PlanSubmission | undefined {
    const plan = this.pendingPlans.get(planId);
    if (!plan || (expected && !this.matchesTarget(plan, expected))) return undefined;
    return plan;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async enqueueApproval(params: PlanSubmissionInput): Promise<PlanApprovalResult> {
    const parsedAgent = parseScopedSwarmAgentId(params.agentId);
    const scope = params.scope ?? parsedAgent?.scope;
    if (scope && parsedAgent && getSwarmRunScopeKey(parsedAgent.scope) !== getSwarmRunScopeKey(scope)) {
      throw new Error(`Plan agent ${params.agentId} does not belong to the requested run scope`);
    }
    const agentId = scope && !parsedAgent
      ? createScopedSwarmAgentId(scope, params.agentId)
      : params.agentId;
    const queueKey = scope ? getSwarmRunScopeKey(scope) : '__legacy__';
    if (scope) this.approvalQueueScopes.set(queueKey, scope);
    const previous = this.approvalQueues.get(queueKey) ?? Promise.resolve();

    const execution = previous.then(async () => {
        const cancellationReason = this.cancelAllReason
          ?? this.cancelledRunReasons.get(queueKey)
          ?? (params.signal?.aborted
            ? normalizeCancellationReason(params.signal.reason, 'parent-cancel')
            : undefined);
        if (cancellationReason) {
          return {
            approved: false,
            feedback: `Cancelled: ${cancellationReason}`,
            autoApproved: true,
          } satisfies PlanApprovalResult;
        }
        const planId = `plan_${queueKey}_${++this.planCounter}_${Date.now()}`;
        const parsedCoordinator = parseScopedSwarmAgentId(params.coordinatorId);
        if (
          scope
          && parsedCoordinator
          && getSwarmRunScopeKey(parsedCoordinator.scope) !== getSwarmRunScopeKey(scope)
        ) {
          throw new Error(`Plan coordinator ${params.coordinatorId} does not belong to the requested run scope`);
        }
        const coordinatorId = scope && !parsedCoordinator
          ? createScopedSwarmAgentId(scope, params.coordinatorId)
          : params.coordinatorId;

        const submission: PlanSubmission = {
          id: planId,
          agentId,
          agentName: params.agentName,
          coordinatorId,
          plan: params.plan,
          risk: params.risk,
          submittedAt: Date.now(),
          status: 'pending',
          scope,
        };

        this.pendingPlans.set(planId, submission);
        this.safePersistInsert(submission);

        const reviewContent = `Risk: ${params.risk.level} (${params.risk.reasons.join(', ')})\n\n${params.plan}`;
        // Notify coordinator via TeammateService
        try {
          const teammateService = getTeammateService();
          teammateService.sendPlanReview(
            agentId,
            coordinatorId,
            `[Plan ID: ${planId}]\n${reviewContent}`,
            planId,
            scope,
          );
        } catch (err) {
          logger.warn('Failed to send plan review via TeammateService', err);
        }
        if (scope) {
          publishSwarmEvent(scope, {
            type: 'swarm:agent:plan_review',
            timestamp: submission.submittedAt,
            data: {
              agentId,
              plan: {
                id: planId,
                agentId,
                content: reviewContent,
                status: 'pending',
              },
            },
          });
        }

        logger.info(`[${params.agentName}] Plan submitted for approval: ${planId} (risk: ${params.risk.level})`);

        // Wait for approval with timeout
        return this.waitForApproval(planId, params.signal);
    });

    const tail = execution.then(() => undefined, () => undefined);
    this.approvalQueues.set(queueKey, tail);
    void tail.finally(() => {
      if (this.approvalQueues.get(queueKey) === tail) {
        this.approvalQueues.delete(queueKey);
        this.approvalQueueScopes.delete(queueKey);
      }
    });
    return execution;
  }

  private waitForApproval(planId: string, signal?: AbortSignal): Promise<PlanApprovalResult> {
    return new Promise<PlanApprovalResult>((resolve) => {
      let settled = false;
      const finish = (result: PlanApprovalResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', rejectForAbort);
        resolve(result);
      };
      const rejectForAbort = () => {
        if (!this.pendingResolvers.has(planId)) return;
        this.pendingResolvers.delete(planId);
        const reason = normalizeCancellationReason(signal?.reason, 'parent-cancel');
        const feedback = `Cancelled: ${reason}`;
        const now = Date.now();
        const plan = this.pendingPlans.get(planId);
        if (plan?.status === 'pending') {
          plan.status = 'rejected';
          plan.feedback = feedback;
          plan.resolvedAt = now;
          this.safePersistResolve(planId, 'rejected', feedback, now);
          this.publishPlanDecision(plan, 'rejected', feedback);
          this.notifyPlanDecision(plan, false, feedback);
        }
        finish({ approved: false, feedback, autoApproved: true });
      };

      this.pendingResolvers.set(planId, finish);
      if (signal?.aborted) {
        rejectForAbort();
        return;
      }
      signal?.addEventListener('abort', rejectForAbort, { once: true });

      // Fail-closed timeout：超时后若 resolver 仍未触发，则 auto-reject
      // medium/high risk 不应在无人值守时放行
      setTimeout(() => {
        if (!this.pendingResolvers.has(planId)) return;
        this.pendingResolvers.delete(planId);

        const plan = this.pendingPlans.get(planId);
        const riskLevel = plan?.risk.level ?? 'unknown';
        const rejectFeedback = `Auto-rejected after timeout (${this.approvalTimeoutMs}ms, risk: ${riskLevel}). Coordinator did not respond; destructive plans require explicit approval.`;
        logger.warn(`Plan ${planId} approval timed out after ${this.approvalTimeoutMs}ms, auto-rejecting (risk: ${riskLevel})`);
        const now = Date.now();
        if (plan && plan.status === 'pending') {
          plan.status = 'rejected';
          plan.feedback = rejectFeedback;
          plan.resolvedAt = now;
          this.publishPlanDecision(plan, 'rejected', rejectFeedback);
          this.notifyPlanDecision(plan, false, rejectFeedback);
        }
        this.safePersistResolve(planId, 'rejected', rejectFeedback, now);

        finish({
          approved: false,
          feedback: rejectFeedback,
          autoApproved: true,
        });
      }, this.approvalTimeoutMs);
    });
  }

  private matchesTarget(plan: PlanSubmission, expected: SwarmAgentRef): boolean {
    return Boolean(
      plan.scope
      && isSameSwarmRun(plan.scope, expected)
      && plan.agentId === expected.agentId,
    );
  }

  private publishPlanDecision(
    plan: PlanSubmission,
    status: 'approved' | 'rejected',
    feedback?: string,
  ): void {
    if (!plan.scope) return;
    publishSwarmEvent(plan.scope, {
      type: status === 'approved' ? 'swarm:agent:plan_approved' : 'swarm:agent:plan_rejected',
      timestamp: plan.resolvedAt ?? Date.now(),
      data: {
        agentId: plan.agentId,
        plan: {
          id: plan.id,
          agentId: plan.agentId,
          content: plan.plan,
          status,
          feedback,
        },
      },
    });
  }

  private notifyPlanDecision(
    plan: PlanSubmission,
    approved: boolean,
    feedback?: string,
  ): void {
    try {
      const teammateService = getTeammateService();
      if (approved) {
        teammateService.approvePlan(
          plan.coordinatorId,
          plan.agentId,
          plan.id,
          feedback,
          plan.scope,
        );
      } else {
        teammateService.rejectPlan(
          plan.coordinatorId,
          plan.agentId,
          plan.id,
          feedback ?? 'Rejected',
          plan.scope,
        );
      }
    } catch (err) {
      logger.warn(`Failed to notify plan decision for ${plan.id}`, err);
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let gateInstance: PlanApprovalGate | null = null;

export function getPlanApprovalGate(): PlanApprovalGate {
  if (!gateInstance) {
    gateInstance = new PlanApprovalGate();
  }
  return gateInstance;
}

export function resetPlanApprovalGate(): void {
  gateInstance = null;
}
