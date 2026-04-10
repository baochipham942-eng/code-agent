// ============================================================================
// Swarm Launch Approval Gate - 并行编排启动前确认
// ============================================================================

import { BrowserWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import type {
  SwarmLaunchRequest,
  SwarmLaunchTaskPreview,
} from '../../shared/types/swarm';
import { emitSwarmEvent } from '../ipc/swarm.ipc';

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
  private readonly approvalTimeoutMs: number;

  constructor(options?: { approvalTimeoutMs?: number }) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 120_000;
  }

  async requestApproval(params: {
    tasks: SwarmLaunchTaskPreview[];
    summary?: string;
  }): Promise<SwarmLaunchApprovalResult> {
    const request = this.createRequest(params.tasks, params.summary);

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
    emitSwarmEvent({
      type: 'swarm:launch:requested',
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
    emitSwarmEvent({
      type: 'swarm:launch:approved',
      timestamp: request.resolvedAt,
      data: { launchRequest: { ...request } },
    });
    logger.info(`Swarm launch approved: ${requestId}`);
    return true;
  }

  reject(requestId: string, feedback: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;

    request.status = 'rejected';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    emitSwarmEvent({
      type: 'swarm:launch:rejected',
      timestamp: request.resolvedAt,
      data: { launchRequest: { ...request } },
    });
    logger.info(`Swarm launch rejected: ${requestId}`);
    return true;
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
  ): SwarmLaunchRequest {
    const requestedAt = Date.now();
    return {
      id: `launch_${++this.counter}_${requestedAt}`,
      status: 'pending',
      requestedAt,
      summary: summary || `准备并行启动 ${tasks.length} 个 agent`,
      agentCount: tasks.length,
      dependencyCount: tasks.reduce((total, task) => total + (task.dependsOn?.length || 0), 0),
      writeAgentCount: tasks.filter((task) => task.writeAccess).length,
      tasks: tasks.map((task) => ({ ...task })),
    };
  }

  private async waitForDecision(requestId: string): Promise<SwarmLaunchApprovalResult> {
    const startedAt = Date.now();
    const pollIntervalMs = 400;

    while (Date.now() - startedAt < this.approvalTimeoutMs) {
      const request = this.requests.get(requestId);
      if (!request) {
        throw new Error(`Launch request not found: ${requestId}`);
      }

      if (request.status === 'approved') {
        return {
          approved: true,
          feedback: request.feedback,
          autoApproved: false,
          request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
        };
      }

      if (request.status === 'rejected') {
        return {
          approved: false,
          feedback: request.feedback,
          autoApproved: false,
          request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const timeoutFeedback = 'Auto-approved after timeout';
    const approved = this.approve(requestId, timeoutFeedback);
    const request = this.getRequest(requestId);
    if (!approved || !request) {
      throw new Error(`Failed to auto-approve launch request: ${requestId}`);
    }

    logger.warn(`Swarm launch approval timed out: ${requestId}`);
    return {
      approved: true,
      feedback: timeoutFeedback,
      autoApproved: true,
      request,
    };
  }
}

let gateInstance: SwarmLaunchApprovalGate | null = null;

export function getSwarmLaunchApprovalGate(): SwarmLaunchApprovalGate {
  if (!gateInstance) {
    gateInstance = new SwarmLaunchApprovalGate();
  }
  return gateInstance;
}
