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
import type { ToolExecutionRequest } from './subagentPipeline';

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
  /** Serial queue to prevent concurrent approval conflicts */
  private approvalQueue: Promise<void> = Promise.resolve();
  /** Default timeout for coordinator response (30 seconds) */
  private approvalTimeoutMs: number;

  constructor(options?: { approvalTimeoutMs?: number }) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 30_000;
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
  async submitForApproval(params: {
    agentId: string;
    agentName: string;
    coordinatorId: string;
    plan: string;
    risk: RiskAssessment;
  }): Promise<PlanApprovalResult> {
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
  approve(planId: string, feedback?: string): boolean {
    const plan = this.pendingPlans.get(planId);
    if (!plan || plan.status !== 'pending') return false;

    plan.status = 'approved';
    plan.feedback = feedback;
    plan.resolvedAt = Date.now();
    logger.info(`Plan approved: ${planId} for ${plan.agentName}`);
    return true;
  }

  /**
   * Reject a pending plan.
   */
  reject(planId: string, reason: string): boolean {
    const plan = this.pendingPlans.get(planId);
    if (!plan || plan.status !== 'pending') return false;

    plan.status = 'rejected';
    plan.feedback = reason;
    plan.resolvedAt = Date.now();
    logger.info(`Plan rejected: ${planId} for ${plan.agentName} — ${reason}`);
    return true;
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  getPendingPlans(): PlanSubmission[] {
    return Array.from(this.pendingPlans.values())
      .filter(p => p.status === 'pending');
  }

  getPlan(planId: string): PlanSubmission | undefined {
    return this.pendingPlans.get(planId);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async enqueueApproval(params: {
    agentId: string;
    agentName: string;
    coordinatorId: string;
    plan: string;
    risk: RiskAssessment;
  }): Promise<PlanApprovalResult> {
    // Serial queue to avoid concurrent plan conflicts
    return new Promise<PlanApprovalResult>((resolve) => {
      this.approvalQueue = this.approvalQueue.then(async () => {
        const planId = `plan_${++this.planCounter}_${Date.now()}`;

        const submission: PlanSubmission = {
          id: planId,
          agentId: params.agentId,
          agentName: params.agentName,
          coordinatorId: params.coordinatorId,
          plan: params.plan,
          risk: params.risk,
          submittedAt: Date.now(),
          status: 'pending',
        };

        this.pendingPlans.set(planId, submission);

        // Notify coordinator via TeammateService
        try {
          const teammateService = getTeammateService();
          teammateService.sendPlanReview(
            params.agentId,
            params.coordinatorId,
            `[Plan ID: ${planId}]\nRisk: ${params.risk.level} (${params.risk.reasons.join(', ')})\n\n${params.plan}`,
          );
        } catch (err) {
          logger.warn('Failed to send plan review via TeammateService', err);
        }

        logger.info(`[${params.agentName}] Plan submitted for approval: ${planId} (risk: ${params.risk.level})`);

        // Wait for approval with timeout
        const result = await this.waitForApproval(planId);
        resolve(result);
      });
    });
  }

  private async waitForApproval(planId: string): Promise<PlanApprovalResult> {
    const startTime = Date.now();
    const pollInterval = 500; // Check every 500ms

    while (Date.now() - startTime < this.approvalTimeoutMs) {
      const plan = this.pendingPlans.get(planId);
      if (!plan) {
        return { approved: false, feedback: 'Plan not found', autoApproved: false };
      }

      if (plan.status === 'approved') {
        return { approved: true, feedback: plan.feedback, autoApproved: false };
      }

      if (plan.status === 'rejected') {
        return { approved: false, feedback: plan.feedback, autoApproved: false };
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Timeout: auto-approve with warning
    logger.warn(`Plan ${planId} approval timed out after ${this.approvalTimeoutMs}ms, auto-approving`);
    const plan = this.pendingPlans.get(planId);
    if (plan) {
      plan.status = 'approved';
      plan.feedback = 'Auto-approved after timeout';
      plan.resolvedAt = Date.now();
    }

    return {
      approved: true,
      feedback: 'Auto-approved after timeout',
      autoApproved: true,
    };
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
