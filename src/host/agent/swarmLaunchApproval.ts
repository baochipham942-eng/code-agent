// ============================================================================
// Swarm Launch Approval Gate - 并行编排启动前确认
// ============================================================================
// 施工单二 B：遵从会话权限档——
// headless 自动批 → 全只读立即批 → acceptEdits/bypassPermissions 立即批
// → 其余档等待用户（无超时自动拒/批；cancel*/hydrate 仍可排干 pending）。
// ============================================================================

import { AppWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import { withApprovalTrace } from '../telemetry/telemetryService';
import type {
  SwarmLaunchRequest,
  SwarmLaunchTaskPreview,
  SwarmRunRef,
  SwarmRunScope,
} from '../../shared/contract/swarm';
import { getSwarmRunScopeKey } from '../../shared/contract/swarm';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { getPermissionModeManager } from '../permissions/modes';
import { getSwarmEventEmitter } from './swarmEventPublisher';

const logger = createLogger('SwarmLaunchApprovalGate');

export interface SwarmLaunchApprovalResult {
  approved: boolean;
  feedback?: string;
  autoApproved: boolean;
  request: SwarmLaunchRequest;
}

export class SwarmLaunchApprovalGate {
  private requests = new Map<string, SwarmLaunchRequest>();
  private counter = 0;
  /** Resolvers for in-flight waitForDecision promises (event-driven wake-up) */
  private pendingResolvers = new Map<string, (result: SwarmLaunchApprovalResult) => void>();
  /**
   * 持久化仓库（ADR-010 #2）。null 表示 DB 未就绪 / 测试不需要持久化。
   */
  private persistRepo: PendingApprovalRepository | null = null;

  /** 兼容旧调用方；超时自动拒/批已退役，options 忽略。 */
  constructor(_options?: { approvalTimeoutMs?: number }) {}

  /**
   * 注入持久化 repo，并 hydrate 上次进程崩溃残留的 launch pending 行。
   * Durable Agent Team 的 approval identity 跨 attempt 稳定；重启只能恢复
   * 同一 pending request，不能把它改写成 rejected 或重新发起第二个 approval。
   * resolver 由后续全局 recovery dispatch 注册，本层只恢复可见投影。
   */
  attachPersistence(repo: PendingApprovalRepository, _now: number = Date.now()): number {
    this.persistRepo = repo;
    let hydrated = 0;
    try {
      const pending = repo.listByKindAndStatus('launch', 'pending');
      for (const row of pending) {
        if (row.kind !== 'launch') continue;
        try {
          const request = JSON.parse(row.payloadJson) as SwarmLaunchRequest;
          request.status = 'pending';
          this.requests.set(request.id, request);
          hydrated += 1;
        } catch (err) {
          logger.warn(`Failed to hydrate orphaned launch ${row.id}`, err);
        }
      }
      if (hydrated > 0) {
        logger.warn(`Hydrated ${hydrated} waiting swarm launch approval(s) from previous process`);
      }
    } catch (err) {
      logger.error('attachPersistence: failed to hydrate orphaned launches', err);
    }
    return hydrated;
  }

  private safePersistInsert(request: SwarmLaunchRequest): void {
    if (!this.persistRepo) return;
    try {
      this.persistRepo.insert({
        id: request.id,
        kind: 'launch',
        agentId: null,
        agentName: null,
        coordinatorId: null,
        payload: request,
        submittedAt: request.requestedAt,
      });
    } catch (err) {
      logger.warn(`PendingApproval insert failed for ${request.id}`, err);
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

  async requestApproval(params: {
    tasks: SwarmLaunchTaskPreview[];
    summary?: string;
    scope: SwarmRunScope;
    requestId?: string;
  }): Promise<SwarmLaunchApprovalResult> {
    return withApprovalTrace('agent_team_launch', () => this.requestApprovalInternal(params));
  }

  private autoApproveResult(
    request: SwarmLaunchRequest,
    feedback: string,
  ): SwarmLaunchApprovalResult {
    request.status = 'approved';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    logger.info(`Swarm launch auto-approved: ${request.id} (${feedback})`);
    return {
      approved: true,
      feedback,
      autoApproved: true,
      request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
    };
  }

  private async requestApprovalInternal(params: {
    tasks: SwarmLaunchTaskPreview[];
    summary?: string;
    scope: SwarmRunScope;
    requestId?: string;
  }): Promise<SwarmLaunchApprovalResult> {
    const request = this.createRequest(params.tasks, params.scope, params.summary, params.requestId);

    // 1) headless：无 renderer 立即批
    if (AppWindow.getAllWindows().length === 0) {
      logger.info(`No renderer available, auto-approving launch ${request.id}`);
      return this.autoApproveResult(request, 'Auto-approved (headless mode)');
    }

    // 2) 全只读成员：任何权限档立即批（不再干等 120s）
    if (request.writeAgentCount === 0) {
      return this.autoApproveResult(request, 'Auto-approved (read-only agents)');
    }

    // 3) 会话档「替我审批 / 完全访问」：写成员也免批
    // 档位以请求时刻为准（getModeForSession 含会话覆盖与钳制）
    const permissionMode = getPermissionModeManager().getModeForSession(params.scope.sessionId);
    if (permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions') {
      return this.autoApproveResult(
        request,
        `Auto-approved (session permission mode: ${permissionMode})`,
      );
    }

    // 4) 其余档：进等待，无超时自动拒/批；仅 approve/reject/cancel* 结算
    this.requests.set(request.id, request);
    this.safePersistInsert(request);
    getSwarmEventEmitter().launchRequested(request);

    logger.info(`Swarm launch requested: ${request.id} (${request.agentCount} agents, mode=${permissionMode})`);
    return this.waitForDecision(request.id);
  }

  approve(requestId: string, feedback?: string, expectedScope?: SwarmRunRef): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    if (expectedScope && (request.sessionId !== expectedScope.sessionId || request.runId !== expectedScope.runId)) return false;

    request.status = 'approved';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    this.safePersistResolve(requestId, 'approved', feedback ?? null, request.resolvedAt);
    getSwarmEventEmitter().launchApproved({ ...request });
    logger.info(`Swarm launch approved: ${requestId}`);

    // Event-driven wake-up
    const resolver = this.pendingResolvers.get(requestId);
    if (resolver) {
      this.pendingResolvers.delete(requestId);
      resolver({
        approved: true,
        feedback,
        autoApproved: false,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
    }
    return true;
  }

  reject(requestId: string, feedback: string, expectedScope?: SwarmRunRef): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    if (expectedScope && (request.sessionId !== expectedScope.sessionId || request.runId !== expectedScope.runId)) return false;

    request.status = 'rejected';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    this.safePersistResolve(requestId, 'rejected', feedback, request.resolvedAt);
    getSwarmEventEmitter().launchRejected({ ...request });
    logger.info(`Swarm launch rejected: ${requestId}`);

    const resolver = this.pendingResolvers.get(requestId);
    if (resolver) {
      this.pendingResolvers.delete(requestId);
      resolver({
        approved: false,
        feedback,
        autoApproved: false,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
    }
    return true;
  }

  /**
   * Cancel all pending launch approvals with a common reason.
   * ADR-010 #6：swarm 取消或进程 shutdown 时排干 pendingResolvers。
   * 返回被取消的 request 数量。
   */
  cancelAll(reason: string): number {
    if (this.pendingResolvers.size === 0) return 0;
    const feedback = `Cancelled: ${reason}`;
    let cancelled = 0;
    const now = Date.now();
    const entries = Array.from(this.pendingResolvers.entries());
    this.pendingResolvers.clear();
    for (const [requestId, resolver] of entries) {
      const request = this.requests.get(requestId);
      if (request?.status === 'pending') {
        request.status = 'rejected';
        request.feedback = feedback;
        request.resolvedAt = now;
        getSwarmEventEmitter().launchRejected({ ...request });
      }
      this.safePersistResolve(requestId, 'rejected', feedback, now);
      try {
        resolver({
          approved: false,
          feedback,
          autoApproved: true,
          request: request
            ? { ...request, tasks: request.tasks.map((task) => ({ ...task })) }
            : {
                id: requestId,
                sessionId: '__unknown__',
                runId: '__unknown__',
                treeId: '__unknown__',
                status: 'rejected',
                requestedAt: 0,
                summary: '',
                agentCount: 0,
                dependencyCount: 0,
                writeAgentCount: 0,
                tasks: [],
              },
        });
        cancelled += 1;
      } catch (err) {
        logger.warn(`Failed to resolve cancelled launch ${requestId}`, err);
      }
    }
    logger.info(`Cancelled ${cancelled} pending swarm launch approvals (${reason})`);
    return cancelled;
  }

  cancelRun(scope: SwarmRunRef, reason: string): number {
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [requestId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const request = this.requests.get(requestId);
      if (request?.sessionId !== scope.sessionId || request.runId !== scope.runId) continue;

      this.pendingResolvers.delete(requestId);
      request.status = 'rejected';
      request.feedback = feedback;
      request.resolvedAt = now;
      this.safePersistResolve(requestId, 'rejected', feedback, now);
      getSwarmEventEmitter().launchRejected({ ...request });
      resolver({
        approved: false,
        feedback,
        autoApproved: true,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
      cancelled += 1;
    }

    return cancelled;
  }

  /** Session cancellation drains current launches without poisoning future runs. */
  cancelSession(sessionId: string, reason: string): number {
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [requestId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const request = this.requests.get(requestId);
      if (request?.sessionId !== sessionId) continue;

      this.pendingResolvers.delete(requestId);
      request.status = 'rejected';
      request.feedback = feedback;
      request.resolvedAt = now;
      this.safePersistResolve(requestId, 'rejected', feedback, now);
      getSwarmEventEmitter().launchRejected({ ...request });
      resolver({
        approved: false,
        feedback,
        autoApproved: true,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
      cancelled += 1;
    }

    return cancelled;
  }

  getPendingResolverCount(): number {
    return this.pendingResolvers.size;
  }

  getRequest(requestId: string, expectedScope?: SwarmRunRef): SwarmLaunchRequest | undefined {
    const request = this.requests.get(requestId);
    if (request && expectedScope && !this.matchesScope(request, expectedScope)) return undefined;
    return request ? { ...request, tasks: request.tasks.map((task) => ({ ...task })) } : undefined;
  }

  getPendingRequests(scope?: SwarmRunRef): SwarmLaunchRequest[] {
    return Array.from(this.requests.values())
      .filter((request) => request.status === 'pending')
      .filter((request) => !scope || this.matchesScope(request, scope))
      .map((request) => ({
        ...request,
        tasks: request.tasks.map((task) => ({ ...task })),
      }));
  }

  private createRequest(
    tasks: SwarmLaunchTaskPreview[],
    scope: SwarmRunScope,
    summary?: string,
    requestId?: string,
  ): SwarmLaunchRequest {
    const requestedAt = Date.now();
    return {
      id: requestId ?? `launch_${getSwarmRunScopeKey(scope)}_${++this.counter}_${requestedAt}`,
      ...scope,
      status: 'pending',
      requestedAt,
      summary: summary || `准备并行启动 ${tasks.length} 个 agent`,
      agentCount: tasks.length,
      dependencyCount: tasks.reduce((total, task) => total + (task.dependsOn?.length || 0), 0),
      writeAgentCount: tasks.filter((task) => task.writeAccess).length,
      tasks: tasks.map((task) => ({ ...task })),
    };
  }

  private matchesScope(request: SwarmLaunchRequest, scope: SwarmRunRef): boolean {
    return request.sessionId === scope.sessionId && request.runId === scope.runId;
  }

  /** 等待用户 approve/reject 或 cancel*；无超时自动结算。 */
  private waitForDecision(requestId: string): Promise<SwarmLaunchApprovalResult> {
    return new Promise<SwarmLaunchApprovalResult>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);
    });
  }
}

let gateInstance: SwarmLaunchApprovalGate | null = null;

export function getSwarmLaunchApprovalGate(): SwarmLaunchApprovalGate {
  if (!gateInstance) {
    gateInstance = new SwarmLaunchApprovalGate();
  }
  return gateInstance;
}
