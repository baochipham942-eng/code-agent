// ============================================================================
// Swarm Launch Approval Gate - 并行编排启动前确认
// ============================================================================

import { BrowserWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import type {
  SwarmEvent,
  SwarmLaunchRequest,
  SwarmLaunchTaskPreview,
} from '../../shared/contract/swarm';
import { getEventBus } from '../services/eventing/bus';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';

/**
 * ADR-008 Phase 2: 通过 EventBus 发布 swarm launch 事件
 * 替代原 `import { emitSwarmEvent } from '../ipc/swarm.ipc'`，断开 Cycle 4 的反向边。
 * swarm.ipc 的 bridge 订阅器（ensureSwarmBusBridge）会把事件投递给渲染进程 + CLI listeners。
 */
function publishSwarmEvent(event: SwarmEvent): void {
  const busType = event.type.startsWith('swarm:') ? event.type.slice(6) : event.type;
  getEventBus().publish('swarm', busType, event, { bridgeToRenderer: false });
}

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
  private readonly approvalTimeoutMs: number;
  /**
   * 持久化仓库（ADR-010 #2）。null 表示 DB 未就绪 / 测试不需要持久化。
   */
  private persistRepo: PendingApprovalRepository | null = null;

  constructor(options?: { approvalTimeoutMs?: number }) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 120_000;
  }

  /**
   * 注入持久化 repo，并 hydrate 上次进程崩溃残留的 launch pending 行。
   * 残留行被打成 'orphaned' 状态写回内存 Map（不挂 resolver），方便
   * coordinator / 监控 UI 看到上一进程未决的 launch 请求。
   */
  attachPersistence(repo: PendingApprovalRepository, now: number = Date.now()): number {
    this.persistRepo = repo;
    let hydrated = 0;
    try {
      const orphans = repo.markPendingAsOrphaned('launch', now);
      for (const row of orphans) {
        if (row.kind !== 'launch') continue;
        try {
          const request = JSON.parse(row.payloadJson) as SwarmLaunchRequest;
          request.status = 'rejected';
          request.feedback = row.feedback ?? 'Orphaned by process restart';
          request.resolvedAt = row.resolvedAt ?? now;
          this.requests.set(request.id, request);
          hydrated += 1;
        } catch (err) {
          logger.warn(`Failed to hydrate orphaned launch ${row.id}`, err);
        }
      }
      if (hydrated > 0) {
        logger.warn(`Hydrated ${hydrated} orphaned swarm launch approval(s) from previous process`);
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
    sessionId?: string;
  }): Promise<SwarmLaunchApprovalResult> {
    const request = this.createRequest(params.tasks, params.summary, params.sessionId);

    if (BrowserWindow.getAllWindows().length === 0) {
      logger.info(`No renderer available, auto-approving launch ${request.id}`);
      request.status = 'approved';
      request.feedback = 'Auto-approved (headless mode)';
      request.resolvedAt = Date.now();
      return {
        approved: true,
        feedback: request.feedback,
        autoApproved: true,
        request,
      };
    }

    this.requests.set(request.id, request);
    this.safePersistInsert(request);
    publishSwarmEvent({
      type: 'swarm:launch:requested',
      sessionId: request.sessionId,
      timestamp: request.requestedAt,
      data: { launchRequest: request },
    });

    logger.info(`Swarm launch requested: ${request.id} (${request.agentCount} agents)`);
    return this.waitForDecision(request.id);
  }

  approve(requestId: string, feedback?: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;

    request.status = 'approved';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    this.safePersistResolve(requestId, 'approved', feedback ?? null, request.resolvedAt);
    publishSwarmEvent({
      type: 'swarm:launch:approved',
      sessionId: request.sessionId,
      timestamp: request.resolvedAt,
      data: { launchRequest: { ...request } },
    });
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

  reject(requestId: string, feedback: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;

    request.status = 'rejected';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    this.safePersistResolve(requestId, 'rejected', feedback, request.resolvedAt);
    publishSwarmEvent({
      type: 'swarm:launch:rejected',
      sessionId: request.sessionId,
      timestamp: request.resolvedAt,
      data: { launchRequest: { ...request } },
    });
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
      if (request && request.status === 'pending') {
        request.status = 'rejected';
        request.feedback = feedback;
        request.resolvedAt = now;
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

  getPendingResolverCount(): number {
    return this.pendingResolvers.size;
  }

  getRequest(requestId: string): SwarmLaunchRequest | undefined {
    const request = this.requests.get(requestId);
    return request ? { ...request, tasks: request.tasks.map((task) => ({ ...task })) } : undefined;
  }

  getPendingRequests(): SwarmLaunchRequest[] {
    return Array.from(this.requests.values())
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        ...request,
        tasks: request.tasks.map((task) => ({ ...task })),
      }));
  }

  private createRequest(
    tasks: SwarmLaunchTaskPreview[],
    summary?: string,
    sessionId?: string,
  ): SwarmLaunchRequest {
    const requestedAt = Date.now();
    return {
      id: `launch_${++this.counter}_${requestedAt}`,
      sessionId,
      status: 'pending',
      requestedAt,
      summary: summary || `准备并行启动 ${tasks.length} 个 agent`,
      agentCount: tasks.length,
      dependencyCount: tasks.reduce((total, task) => total + (task.dependsOn?.length || 0), 0),
      writeAgentCount: tasks.filter((task) => task.writeAccess).length,
      tasks: tasks.map((task) => ({ ...task })),
    };
  }

  private waitForDecision(requestId: string): Promise<SwarmLaunchApprovalResult> {
    return new Promise<SwarmLaunchApprovalResult>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);

      // Fail-closed timeout 按 writeAgentCount 分档：
      // - 存在 write agent → auto-reject（避免无人职守时并发写冲突）
      // - 全只读 → auto-approve（保活低风险探查场景）
      setTimeout(() => {
        if (!this.pendingResolvers.has(requestId)) return;

        const pending = this.requests.get(requestId);
        if (!pending) {
          this.pendingResolvers.delete(requestId);
          resolve({
            approved: false,
            feedback: `Launch request not found at timeout: ${requestId}`,
            autoApproved: true,
            request: {
              id: requestId,
              status: 'rejected',
              requestedAt: 0,
              summary: '',
              agentCount: 0,
              dependencyCount: 0,
              writeAgentCount: 0,
              tasks: [],
            },
          });
          return;
        }

        const hasWriteAgent = pending.writeAgentCount > 0;

        if (hasWriteAgent) {
          const rejectFeedback = `Auto-rejected after timeout (${this.approvalTimeoutMs}ms, writeAgentCount=${pending.writeAgentCount}). Write-capable swarm launches require explicit approval.`;
          // 提前从 resolver 表移除避免 reject() 二次结算
          this.pendingResolvers.delete(requestId);
          this.reject(requestId, rejectFeedback);
          logger.warn(`Swarm launch auto-rejected on timeout: ${requestId} (writeAgentCount=${pending.writeAgentCount})`);
          resolve({
            approved: false,
            feedback: rejectFeedback,
            autoApproved: true,
            request: this.getRequest(requestId)!,
          });
          return;
        }

        const approveFeedback = `Auto-approved after timeout (${this.approvalTimeoutMs}ms, read-only swarm)`;
        this.pendingResolvers.delete(requestId);
        this.approve(requestId, approveFeedback);
        logger.warn(`Swarm launch auto-approved on timeout (read-only): ${requestId}`);
        resolve({
          approved: true,
          feedback: approveFeedback,
          autoApproved: true,
          request: this.getRequest(requestId)!,
        });
      }, this.approvalTimeoutMs);
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
