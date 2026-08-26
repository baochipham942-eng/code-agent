// ============================================================================
// Workflow Launch Approval Gate —— dynamic-workflow 启动前确认（P3b）
// ============================================================================
// 镜像 swarmLaunchApproval 的 Promise + pendingResolvers + 超时自动决策机制，但用独立契约：
// workflow 跑前没有 tasks[]（脚本才决定子 agent），只有脚本静态预览（phases/扇出量/动写）
// + token 预算。审批卡展示 4 维度（费用/网络/上下文泄露/后台占用）。
//
// 事件投递（deliver）默认 publish 到 EventBus 'workflow' domain（type 前缀 'launch:'），
// workflow.ipc 的专用 bridge 按前缀路由到 'workflow:launch:event' 通道。交互探针/deliver
// 经构造注入（默认走 BrowserWindow + EventBus），方便单测无需 mock platform/bus。
// ============================================================================

import { hasInteractiveUi } from '../platform';
import { createLogger } from '../services/infra/logger';
import { withApprovalTrace } from '../telemetry/telemetryService';
import { getEventBus } from '../services/eventing/bus';
import { INTERACTION_TIMEOUTS, SCRIPT_RUNTIME } from '../../shared/constants';
import type {
  WorkflowLaunchRequest,
  WorkflowLaunchDimensions,
  WorkflowLaunchEvent,
} from '../../shared/contract/scriptRun';
import type { ScriptPreview } from './scriptRuntime/scriptPreview';
import {
  clearExpiredDecisionRequest,
  deniedDecisionMetadata,
  headlessDecisionTimeoutReason,
  markDecisionRequestExpired,
  notifyDecisionNeeded,
  notifyIfLateDecisionResponse,
} from '../interaction/userDecision';

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
  permissionDecision?: 'allow' | 'deny';
  permissionDecisionReason?: string;
}

export interface WorkflowLaunchGateOptions {
  approvalTimeoutMs?: number;
  /** 测试注入点；生产默认使用 platform 唯一交互探针。 */
  hasInteractiveUi?: () => boolean;
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
  private readonly interactiveUiAvailable: () => boolean;
  private readonly deliver: (event: WorkflowLaunchEvent) => void;
  private readonly now: () => number;

  constructor(options?: WorkflowLaunchGateOptions) {
    this.approvalTimeoutMs = options?.approvalTimeoutMs ?? 120_000;
    this.interactiveUiAvailable = options?.hasInteractiveUi ?? hasInteractiveUi;
    this.deliver = options?.deliver ?? defaultDeliver;
    this.now = options?.now ?? (() => Date.now());
  }

  async requestApproval(params: { request: WorkflowLaunchRequest }): Promise<WorkflowLaunchApprovalResult> {
    return withApprovalTrace('workflow_launch', () => this.requestApprovalInternal(params));
  }

  private async requestApprovalInternal(params: { request: WorkflowLaunchRequest }): Promise<WorkflowLaunchApprovalResult> {
    const request = params.request;

    const interactive = this.interactiveUiAvailable();
    clearExpiredDecisionRequest(request.id);

    // 关键顺序（Codex R1 MED#1）：先 set request + 注册 resolver/timeout，【再】deliver。
    // 否则同步 deliver（测试注入 / 极快 UI）里调 approve/reject 时 resolver 还没登记 → 决议丢失。
    this.requests.set(request.id, request);
    const promise = this.waitForDecision(request.id, interactive);
    if (interactive) {
      this.deliver({ type: 'requested', request: { ...request } });
      notifyDecisionNeeded({
        sessionId: request.sessionId,
        title: '工作流等待启动确认',
        body: request.goal ?? `预计调用 ${request.estimatedAgentCalls} 个 Agent`,
      });
      logger.info(`Workflow launch requested: ${request.id} (${request.estimatedAgentCalls} agent calls)`);
    } else {
      logger.info(`Workflow launch waiting for headless policy timeout: ${request.id}`);
    }
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
    if (request?.status !== 'pending') {
      notifyIfLateDecisionResponse(requestId);
      return false;
    }
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

  private waitForDecision(requestId: string, interactive: boolean): Promise<WorkflowLaunchApprovalResult> {
    return new Promise<WorkflowLaunchApprovalResult>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);
      const timeoutMs = interactive
        ? INTERACTION_TIMEOUTS.PARKED_APPROVAL
        : this.approvalTimeoutMs;
      const handle = setTimeout(() => {
        const pending = this.requests.get(requestId);
        if (pending?.status !== 'pending') return; // 已被人工决议
        const approved = !interactive && !pending.writeHint;
        const reason = interactive
          ? '等待工作流启动确认超过 24 小时，停车请求已按安全兜底拒绝。'
          : approved
            ? `等你决定超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已按无头规则处理：只读工作流按现有规则自动批准。`
            : headlessDecisionTimeoutReason(timeoutMs);
        pending.status = approved ? 'approved' : 'rejected';
        pending.feedback = reason;
        pending.resolvedAt = this.now();
        markDecisionRequestExpired(requestId, '工作流启动确认');
        if (interactive) {
          this.deliver({ type: approved ? 'approved' : 'rejected', request: { ...pending } });
        }
        logger.warn(`Workflow launch auto-${approved ? 'approved' : 'rejected'} on timeout: ${requestId}`);
        this.settle(requestId, {
          approved,
          feedback: pending.feedback,
          autoApproved: true,
          request: { ...pending },
          ...(approved
            ? { permissionDecision: 'allow' as const, permissionDecisionReason: reason }
            : deniedDecisionMetadata(reason)),
        });
      }, timeoutMs);
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
