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

import { AppWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import { withApprovalTrace } from '../telemetry/telemetryService';
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
  // 每个 pending 请求的超时句柄，settle 时 clearTimeout（Codex R1 MED#1：原本不清，timer 白活到超时）。
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly approvalTimeoutMs: number;
  private readonly hasRenderer: () => boolean;
  private readonly deliver: (event: WorkflowLaunchEvent) => void;
  private readonly now: () => number;

  constructor(options?: WorkflowLaunchGateOptions) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 120_000;
    this.hasRenderer = options?.hasRenderer ?? (() => AppWindow.getAllWindows().length > 0);
    this.deliver = options?.deliver ?? defaultDeliver;
    this.now = options?.now ?? (() => Date.now());
  }

  async requestApproval(params: { request: WorkflowLaunchRequest }): Promise<WorkflowLaunchApprovalResult> {
    return withApprovalTrace('workflow_launch', () => this.requestApprovalInternal(params));
  }

  private async requestApprovalInternal(params: { request: WorkflowLaunchRequest }): Promise<WorkflowLaunchApprovalResult> {
    const request = params.request;

    if (!this.hasRenderer()) {
      request.status = 'approved';
      request.feedback = 'Auto-approved (headless mode)';
      request.resolvedAt = this.now();
      logger.info(`No renderer, auto-approving workflow launch ${request.id}`);
      return { approved: true, feedback: request.feedback, autoApproved: true, request };
    }

    // 关键顺序（Codex R1 MED#1）：先 set request + 注册 resolver/timeout，【再】deliver。
    // 否则同步 deliver（测试注入 / 极快 UI）里调 approve/reject 时 resolver 还没登记 → 决议丢失。
    this.requests.set(request.id, request);
    const promise = this.waitForDecision(request.id); // Promise executor 同步跑：登记 resolver + arm timeout
    this.deliver({ type: 'requested', request: { ...request } });
    logger.info(`Workflow launch requested: ${request.id} (${request.estimatedAgentCalls} agent calls)`);
    return promise;
  }

  approve(requestId: string, feedback?: string, callerSessionId?: string): boolean {
    return this.resolveManual(requestId, true, feedback, callerSessionId);
  }

  reject(requestId: string, feedback: string, callerSessionId?: string): boolean {
    return this.resolveManual(requestId, false, feedback, callerSessionId);
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

  /** 人工 approve/reject 公共路径（autoApproved=false）。 */
  private resolveManual(requestId: string, approved: boolean, feedback?: string, callerSessionId?: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    // 会话授权（Codex R2 HIGH#1）：UI 不显示别会话的卡只是 display filter；这里是真授权边界——
    // 请求归某会话时，只有该会话的调用方能决议。callerSessionId 缺省（headless/legacy）不阻断。
    if (request.sessionId && callerSessionId && request.sessionId !== callerSessionId) {
      logger.warn(`Cross-session ${approved ? 'approve' : 'reject'} refused: ${requestId} (owner=${request.sessionId}, caller=${callerSessionId})`);
      return false;
    }
    request.status = approved ? 'approved' : 'rejected';
    request.feedback = feedback;
    request.resolvedAt = this.now();
    this.deliver({ type: approved ? 'approved' : 'rejected', request: { ...request } });
    logger.info(`Workflow launch ${approved ? 'approved' : 'rejected'}: ${requestId}`);
    this.settle(requestId, { approved, feedback, autoApproved: false, request: { ...request } });
    return true;
  }

  /** 终态收尾：clearTimeout + 删 resolver + 删 requests（防 timer/map 泄漏）+ resolve 一次。 */
  private settle(requestId: string, result: WorkflowLaunchApprovalResult): void {
    const t = this.timeouts.get(requestId);
    if (t) { clearTimeout(t); this.timeouts.delete(requestId); }
    const resolver = this.pendingResolvers.get(requestId);
    this.pendingResolvers.delete(requestId);
    this.requests.delete(requestId);
    if (resolver) resolver(result);
  }

  private waitForDecision(requestId: string): Promise<WorkflowLaunchApprovalResult> {
    return new Promise<WorkflowLaunchApprovalResult>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);
      // Fail-closed 超时分档（对齐 swarm）：含写能力 → auto-reject；全只读 → auto-approve。
      const handle = setTimeout(() => {
        const pending = this.requests.get(requestId);
        if (pending?.status !== 'pending') return; // 已被人工决议
        const approved = !pending.writeHint;
        pending.status = approved ? 'approved' : 'rejected';
        pending.feedback = approved
          ? `Auto-approved after timeout (${this.approvalTimeoutMs}ms, read-only)`
          : `Auto-rejected after timeout (${this.approvalTimeoutMs}ms)；含写能力子 agent 需显式批准`;
        pending.resolvedAt = this.now();
        this.deliver({ type: approved ? 'approved' : 'rejected', request: { ...pending } });
        logger.warn(`Workflow launch auto-${approved ? 'approved' : 'rejected'} on timeout: ${requestId}`);
        this.settle(requestId, { approved, feedback: pending.feedback, autoApproved: true, request: { ...pending } });
      }, this.approvalTimeoutMs);
      this.timeouts.set(requestId, handle);
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
