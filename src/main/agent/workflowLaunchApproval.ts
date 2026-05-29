// ============================================================================
// Workflow Launch Approval Gate —— dynamic-workflow 启动前确认（P3b）
// ============================================================================
// 镜像 swarmLaunchApproval 的 Promise + pendingResolvers + 超时自动决策机制，但用独立契约：
// workflow 跑前没有 tasks[]（脚本才决定子 agent），只有脚本静态预览（phases/扇出量/动写）
// + token 预算。审批卡展示 4 维度（费用/网络/上下文泄露/后台占用）。
//
// 事件投递（deliver）默认 publish 到 EventBus 'workflow' domain（type 前缀 'launch:'），
// workflow.ipc 的专用 bridge 按前缀路由到 'workflow:launch:event' 通道。hasRenderer/deliver
// 经构造注入（默认走 BrowserWindow + EventBus），方便单测无需 mock platform/bus。
// ============================================================================

import { BrowserWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import { getEventBus } from '../services/eventing/bus';
import { SCRIPT_RUNTIME } from '../../shared/constants';
import type {
  WorkflowLaunchRequest,
  WorkflowLaunchDimensions,
  WorkflowLaunchEvent,
} from '../../shared/contract/scriptRun';
import type { ScriptPreview } from './scriptRuntime/scriptPreview';

const logger = createLogger('WorkflowLaunchApprovalGate');

const WORKER_TIMEOUT_MIN = Math.round(SCRIPT_RUNTIME.WORKER_TIMEOUT_MS / 60_000);

/** 把脚本静态预览映射成审批请求 + 4 维度成本/风险文案。 */
export function buildWorkflowLaunchRequest(params: {
  id: string;
  preview: ScriptPreview;
  goal?: string;
  budgetTokens?: number;
  sessionId?: string;
  now: number;
}): WorkflowLaunchRequest {
  const { id, preview, goal, budgetTokens, sessionId, now } = params;
  const fanoutSites = preview.parallelCallSites + preview.pipelineCallSites;

  const dimensions: WorkflowLaunchDimensions = {
    cost: budgetTokens
      ? `约 ${preview.agentCallSites} 个子 agent 调用，token 预算硬上限 ${budgetTokens.toLocaleString()}（耗尽即停）`
      : `约 ${preview.agentCallSites} 个子 agent 调用，token 不限（无预算上限）`,
    network: '子 agent 默认可联网（WebSearch / WebFetch）收集信息',
    contextLeak: '中间结果留在脚本内，不进主对话上下文；仅最终结果回传',
    background: preview.writeHint
      ? `后台 worker 执行（最长 ${WORKER_TIMEOUT_MIN} 分钟）；含可写文件 / 跑命令的子 agent`
      : `后台 worker 执行（最长 ${WORKER_TIMEOUT_MIN} 分钟）；子 agent 只读`,
  };

  return {
    id,
    status: 'pending',
    requestedAt: now,
    sessionId,
    goal,
    phases: [...preview.phases],
    estimatedAgentCalls: preview.agentCallSites,
    fanoutSites,
    writeHint: preview.writeHint,
    budgetTokens,
    dimensions,
  };
}

export interface WorkflowLaunchApprovalResult {
  approved: boolean;
  feedback?: string;
  autoApproved: boolean;
  request: WorkflowLaunchRequest;
}

export interface WorkflowLaunchGateOptions {
  approvalTimeoutMs?: number;
  /** 是否有渲染进程可审批（默认看 BrowserWindow）。无 → headless auto-approve。 */
  hasRenderer?: () => boolean;
  /** 投递审批事件到 renderer（默认 publish 到 EventBus 'workflow' domain，bridge 路由）。 */
  deliver?: (event: WorkflowLaunchEvent) => void;
  now?: () => number;
}

function defaultDeliver(event: WorkflowLaunchEvent): void {
  // type 前缀 'launch:'，workflow.ipc bridge 据此路由到 launch 通道（与 run 事件区分）。
  getEventBus().publish('workflow', `launch:${event.type}`, event, { bridgeToRenderer: false });
}

export class WorkflowLaunchApprovalGate {
  private requests = new Map<string, WorkflowLaunchRequest>();
  private pendingResolvers = new Map<string, (r: WorkflowLaunchApprovalResult) => void>();
  private readonly approvalTimeoutMs: number;
  private readonly hasRenderer: () => boolean;
  private readonly deliver: (event: WorkflowLaunchEvent) => void;
  private readonly now: () => number;

  constructor(options?: WorkflowLaunchGateOptions) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 120_000;
    this.hasRenderer = options?.hasRenderer ?? (() => BrowserWindow.getAllWindows().length > 0);
    this.deliver = options?.deliver ?? defaultDeliver;
    this.now = options?.now ?? (() => Date.now());
  }

  async requestApproval(params: { request: WorkflowLaunchRequest }): Promise<WorkflowLaunchApprovalResult> {
    const request = params.request;

    if (!this.hasRenderer()) {
      request.status = 'approved';
      request.feedback = 'Auto-approved (headless mode)';
      request.resolvedAt = this.now();
      logger.info(`No renderer, auto-approving workflow launch ${request.id}`);
      return { approved: true, feedback: request.feedback, autoApproved: true, request };
    }

    this.requests.set(request.id, request);
    this.deliver({ type: 'requested', request: { ...request } });
    logger.info(`Workflow launch requested: ${request.id} (${request.estimatedAgentCalls} agent calls)`);
    return this.waitForDecision(request.id);
  }

  approve(requestId: string, feedback?: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    request.status = 'approved';
    request.feedback = feedback;
    request.resolvedAt = this.now();
    this.deliver({ type: 'approved', request: { ...request } });
    logger.info(`Workflow launch approved: ${requestId}`);
    this.resolve(requestId, { approved: true, feedback, autoApproved: false, request: { ...request } });
    return true;
  }

  reject(requestId: string, feedback: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    request.status = 'rejected';
    request.feedback = feedback;
    request.resolvedAt = this.now();
    this.deliver({ type: 'rejected', request: { ...request } });
    logger.info(`Workflow launch rejected: ${requestId}`);
    this.resolve(requestId, { approved: false, feedback, autoApproved: false, request: { ...request } });
    return true;
  }

  getPendingRequests(): WorkflowLaunchRequest[] {
    return Array.from(this.requests.values())
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r }));
  }

  getRequest(requestId: string): WorkflowLaunchRequest | undefined {
    const r = this.requests.get(requestId);
    return r ? { ...r } : undefined;
  }

  private resolve(requestId: string, result: WorkflowLaunchApprovalResult): void {
    const resolver = this.pendingResolvers.get(requestId);
    if (resolver) {
      this.pendingResolvers.delete(requestId);
      resolver(result);
    }
  }

  private waitForDecision(requestId: string): Promise<WorkflowLaunchApprovalResult> {
    return new Promise<WorkflowLaunchApprovalResult>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);

      // Fail-closed 超时分档（对齐 swarm）：含写能力 → auto-reject（无人职守不放写）；
      // 全只读 → auto-approve（保活低风险探查）。
      setTimeout(() => {
        if (!this.pendingResolvers.has(requestId)) return;
        const pending = this.requests.get(requestId);
        if (!pending) {
          this.pendingResolvers.delete(requestId);
          return;
        }
        if (pending.writeHint) {
          const fb = `Auto-rejected after timeout (${this.approvalTimeoutMs}ms)；含写能力子 agent 需显式批准`;
          this.pendingResolvers.delete(requestId);
          this.reject(requestId, fb);
          logger.warn(`Workflow launch auto-rejected on timeout (writeHint): ${requestId}`);
          resolve({ approved: false, feedback: fb, autoApproved: true, request: this.getRequest(requestId)! });
          return;
        }
        const fb = `Auto-approved after timeout (${this.approvalTimeoutMs}ms, read-only)`;
        this.pendingResolvers.delete(requestId);
        this.approve(requestId, fb);
        logger.warn(`Workflow launch auto-approved on timeout (read-only): ${requestId}`);
        resolve({ approved: true, feedback: fb, autoApproved: true, request: this.getRequest(requestId)! });
      }, this.approvalTimeoutMs);
    });
  }
}

let gateInstance: WorkflowLaunchApprovalGate | null = null;

export function getWorkflowLaunchApprovalGate(): WorkflowLaunchApprovalGate {
  if (!gateInstance) {
    gateInstance = new WorkflowLaunchApprovalGate();
  }
  return gateInstance;
}
