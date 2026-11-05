import type { LastToolFailure, LastToolStep, Task } from '@shared/contract/backgroundTask';
import type { ToolStepStatus } from '@shared/contract';
import type { PermissionRequest } from '@shared/contract/permission';
import { findConnectorToolMetadata } from '@shared/contract/workbenchTools';
import type { Translations } from '../i18n';
import { humanizeToolStep } from './humanizeToolStep';
import { humanizeToolError, type HumanizedToolError } from './toolExecutionPresentation';
import type { SessionPermissionNeedsInputState } from './sessionNeedsInput';

/**
 * lastToolFailure 只在任务终态展示（N-MEDIA-GEN-MUSIC-FALLBACK-FU1）：运行中不亮——
 * 中间的失败步不给用户看，host 也可能马上清掉它（同名工具后续成功）。
 * cancelled 不算：那是用户自己的动作，有自己的故事，不叠工具失败叙事。
 */
const LAST_TOOL_FAILURE_VISIBLE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'completed',
  'expired',
  'orphaned',
]);

/** 后台任务终态：过了这些档就不再有新工具步（delegationPresentation 同表唯一源）。 */
const TASK_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
  'orphaned',
]);

/** agentTree 节点的失败/强停档（delegationPresentation 同表唯一源；completed 另判）。 */
const AGENT_NODE_FAILED_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'cancelled',
  'killed',
  'blocked',
  'dead-log-only',
]);

export function isLastToolFailureVisible(status: string | undefined): boolean {
  return status !== undefined && LAST_TOOL_FAILURE_VISIBLE_STATUSES.has(status);
}

/**
 * 终态任务的 lastToolFailure → 人话出路。复用聊天流那套 humanizeToolError 的
 * code 登记文案（含 {alternatives} 插值），不另维护一份翻译。
 */
export function describeLastToolFailure(
  failure: LastToolFailure | undefined,
  t: Translations,
): HumanizedToolError | undefined {
  if (!failure) return undefined;
  return humanizeToolError(undefined, failure.tool, t, {
    code: failure.code,
    ...(failure.alternatives ? { alternatives: failure.alternatives } : {}),
  }) ?? undefined;
}

export function describeLastToolStep(
  step: LastToolStep | undefined,
  t: Translations,
  status: ToolStepStatus = 'completed',
): string | undefined {
  if (!step) return undefined;
  const targetArgs = step.target
    ? {
      file_path: step.target,
      path: step.target,
      notebook_path: step.target,
      command: step.target,
      agentId: step.target,
      target: step.target,
    }
    : undefined;
  return humanizeToolStep(step.tool, targetArgs, t, undefined, status);
}

// ============================================================================
// 后台代理活动行的状态推导（N-APPROVAL-PENDING-STATUS-COPY）
// ----------------------------------------------------------------------------
// LastToolStep 由 host 在工具 START 时写（task_progress），不带结果态，套 completed
// 词形会在审批卡还挂着时谎报「发送了邮件」。这里一处推导供两个消费方共用
// （DelegationReceipt 工作态 / MemberConversationView 普通代理页）：
//   1. 审批未决（pending 或本会话 queued，口径同 useSessionAgentRows.approvalIdsForSession）
//      且请求点名的就是这个任务/代理（agentId/runId 命中关联键）且工具一致
//      → pending-approval；
//   2. 其余连接器写工具（findConnectorToolMetadata 带 action 的写档）在目标还在干活时
//      → running；
//   3. 其余（读类工具、终态目标）维持 completed 旧词形——读类文案本单不动。
// ============================================================================

/** 终态判定：任务不再产生新的工具步。 */
export function isTaskTerminalStatus(status: string | undefined): boolean {
  return TASK_TERMINAL_STATUSES.has(status ?? '');
}

/** 终态判定（agentTree 节点）：completed 或各失败/强停档。 */
export function isAgentNodeTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || AGENT_NODE_FAILED_STATUSES.has(status ?? '');
}

/** 任务 id / runId / metadata.childRunId：审批请求 agentId/runId 命中任一即同一个代理。 */
export function taskActivityIds(task: Task): string[] {
  const childRunId = task.metadata?.childRunId;
  return [task.id, task.runId, ...(typeof childRunId === 'string' ? [childRunId] : [])]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function resolveAgentActivityStepStatus(input: {
  step: LastToolStep | undefined;
  /** 目标还在干活（非终态）；终态一律落 completed 词形。 */
  working: boolean;
  /** 审批关联键：task.id / task.runId / task.metadata.childRunId 或节点 id（applyMemberHolds 同口径）。 */
  activityIds: readonly string[];
  /** 会话作用域；未知时不按会话过滤（id 集本身唯一，不会跨会话误命中）。 */
  sessionId?: string | null;
  /** appStore 的三件审批态；缺省视为没有未决审批。 */
  permission?: SessionPermissionNeedsInputState | null;
}): ToolStepStatus {
  const { step, working, activityIds, sessionId, permission } = input;
  if (!step) return 'completed';
  // 请求点名本目标的三条键路：顶层 agentId / runId（applyMemberHolds 同款），以及
  // turnOrigin[].runId（ADR-067：delegate_task 的审批卡不带顶层 agentId/runId，
  // 发起轮的 runId 即任务的 id/runId——真机 mail_send 卡实证，见任务书背景）。
  const namesThisTarget = (request: PermissionRequest | null | undefined): boolean => {
    if (!request || request.resolved) return false;
    if (request.tool !== step.tool) return false;
    const requestIds = [
      request.agentId,
      request.runId,
      ...(request.turnOrigin ?? []).map((origin) => origin.runId),
    ];
    return requestIds.some((id) => id !== undefined && activityIds.includes(id));
  };
  const pendingInScope = sessionId
    ? permission?.pendingPermissionSessionId === sessionId
    : true;
  if (pendingInScope && namesThisTarget(permission?.pendingPermissionRequest)) {
    return 'pending-approval';
  }
  const queues = permission?.queuedPermissionRequests;
  const queued = sessionId ? queues?.[sessionId] ?? [] : Object.values(queues ?? {}).flat();
  if (queued.some(namesThisTarget)) return 'pending-approval';
  if (working && findConnectorToolMetadata(step.tool)?.action) return 'running';
  return 'completed';
}

export function isDelegationTool(name: string): boolean {
  return name === 'delegate_task' || name === 'spawn_agent';
}
