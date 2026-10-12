// ============================================================================
// ToolExecutor - 权限决策记录与 decision trace 构建
// 从 toolExecutor.ts 抽出，无行为变更（ADR-022 事件账本第一期）。
// ============================================================================

import type { ToolLedgerOrigin } from '../../shared/constants/toolLedger';
import { AUTO_MODE_RATE_LIMIT } from '../../shared/constants/timeouts';
import {
  createHostReason,
  HostReasonCode,
  type PermissionAskResult,
  type PermissionDenialSource,
} from '../../shared/contract/permission';
import type { PermissionRequestData } from './types';
import { getToolLedgerSink } from './toolLedgerSink';
import { getPermissionModeManager } from '../permissions/modes';
import { computePolicyHash } from '../permissions/policyHash';
import {
  getDecisionHistory,
  isAutoDenyOutcome,
  type DecisionOutcome as HistoryDecisionOutcome,
} from '../security/decisionHistory';
import type {
  DecisionLayer,
  DecisionOutcome as TraceDecisionOutcome,
  DecisionTrace,
} from '../../shared/contract/decisionTrace';
import { createTraceStep } from '../security/decisionTraceBuilder';

/** Record a permission decision to the history buffer (+ append-only ledger, ADR-022 第一期) */
export function recordDecision(
  toolName: string, params: Record<string, unknown>,
  outcome: HistoryDecisionOutcome, reason: string, startTime: number, trace?: DecisionTrace,
  sessionId?: string, origin: ToolLedgerOrigin = 'desktop', waitMs?: number,
): void {
  const now = Date.now();
  const summary = String(params.command || params.file_path || params.path || params.pattern || toolName).substring(0, 80);
  const decisionTrace = trace ?? buildHistoryDecisionTrace(toolName, outcome, reason, startTime);
  const durationMs = now - startTime;
  getDecisionHistory().record({
    timestamp: now, toolName, summary,
    fullCommand: typeof params.command === 'string' ? params.command : undefined,
    outcome, reason,
    durationMs,
    decisionTrace,
    sessionId,
  });
  // 自动拦截落账后再判限流。判定留在 toolExecutor 侧：permissions 已经依赖 security
  // （policyEngine → auditLogger，guardFabric → decisionTraceBuilder），不让
  // decisionHistory 反向去调 PermissionModeManager。history 只提供按会话计数。
  noteAutoModeRateLimit(sessionId, outcome);
  // 事件账本持久化（fail-safe）：任何失败都不得影响权限判定 / 工具执行。
  // sink 自身可替换；这里仍套一层兜底，保证任何写入异常不影响主流程。
  try {
    getToolLedgerSink().appendPermissionDecision({
      sessionId,
      toolName,
      summary,
      finalOutcome: decisionTrace.finalOutcome,
      historyOutcome: outcome,
      reason,
      durationMs,
      waitMs,
      origin,
      recordedAt: now,
      trace: decisionTrace,
      policyHash: computePolicyHash(sessionId),
    });
  } catch {
    // 静默：账本写入永不阻断主流程
  }
}

function historyOutcomeToTraceOutcome(outcome: HistoryDecisionOutcome): TraceDecisionOutcome {
  if (outcome === 'auto-approve' || outcome === 'ask-approved' || outcome === 'policy-allow') return 'allow';
  return 'deny';
}

/**
 * 工具体内 ask（canUseTool 内联审批，如 bash 的 sandbox_escalate_once）落权限账本。
 * 外层 ask 由 toolExecutor 权限闸记账（N-APPROVAL-SOURCE-LEDGER #1664 只修了外层）；
 * 这里补内层，让每一次沙箱扩权事后都能查到是谁批的。来源口径与外层一致：
 * 批准来源缺省 'unspecified'（机器批准必须自报，不冒名 'user'），拒绝来源缺省
 * 'user'（裸 boolean 的旧契约语义，normalizePermissionAskResult 已归一）。
 *
 * deniedPath / action 在 PermissionDecisionInput 里没有独立列：放进 trace step 的
 * reason.metadata（随 trace_json 整体落库），step.rule 直接用 action 值（如
 * 'sandbox_escalate_once'）保证账本行可按动作检索。
 */
export function recordInToolPermissionAsk(
  request: PermissionRequestData,
  ask: PermissionAskResult & { denialSource: PermissionDenialSource | undefined },
  startTime: number,
  sessionId: string | undefined,
  origin: ToolLedgerOrigin,
  waitMs: number | undefined,
): void {
  const approved = ask.approved;
  const outcome: HistoryDecisionOutcome = approved ? 'ask-approved' : 'ask-denied';
  const reason = approved ? (ask.approvalSource ?? 'unspecified') : (ask.denialSource ?? 'user');
  const action = typeof request.details.action === 'string' ? request.details.action : undefined;
  const deniedPath = typeof request.details.deniedPath === 'string' ? request.details.deniedPath : undefined;
  const metadata: Record<string, string> = {};
  if (deniedPath) metadata.deniedPath = deniedPath;
  if (action) metadata.action = action;
  const step = createTraceStep(
    'plan_approval',
    action ?? 'in_tool_permission_ask',
    approved ? 'allow' : 'deny',
    createHostReason(
      HostReasonCode.DecisionApproval,
      approved
        ? `in-tool ask approved (source: ${reason})`
        : `in-tool ask denied (source: ${reason})`,
      Object.keys(metadata).length > 0 ? metadata : undefined,
    ),
    startTime,
  );
  recordDecision(
    request.tool, request.details, outcome, reason, startTime,
    { toolName: request.tool, finalOutcome: approved ? 'allow' : 'deny', steps: [step], totalDurationMs: Date.now() - startTime },
    sessionId, origin, waitMs,
  );
}

function historyOutcomeToLayer(outcome: HistoryDecisionOutcome): DecisionLayer {
  if (outcome === 'policy-allow' || outcome === 'policy-deny' || outcome === 'monitor-blocked') {
    return outcome === 'monitor-blocked' ? 'guard_fabric' : 'policy_enforcer';
  }
  if (outcome === 'classifier-deny' || outcome === 'auto-approve') return 'permission_classifier';
  if (outcome === 'hook-blocked') return 'plugin_hook';
  return 'plan_approval';
}

/**
 * 记录到自动拦截之后判一次。达连续或窗口阈值就把该会话标成限流（只标一次）。
 * 非自动拦截不判：它们只负责在 history 里打断连续、不进累计。
 */
function noteAutoModeRateLimit(sessionId: string | undefined, outcome: HistoryDecisionOutcome): void {
  if (!sessionId || !isAutoDenyOutcome(outcome)) return;
  const history = getDecisionHistory();
  const consecutive = history.countConsecutiveAutoDenies(sessionId);
  const windowCount = history.countWindowAutoDenies(sessionId, AUTO_MODE_RATE_LIMIT.WINDOW_MS);
  if (consecutive >= AUTO_MODE_RATE_LIMIT.CONSECUTIVE) {
    getPermissionModeManager().markAutoModeRateLimited(sessionId, 'consecutive', consecutive);
    return;
  }
  if (windowCount >= AUTO_MODE_RATE_LIMIT.WINDOW_COUNT) {
    getPermissionModeManager().markAutoModeRateLimited(sessionId, 'window', windowCount);
  }
}

function buildHistoryDecisionTrace(
  toolName: string,
  outcome: HistoryDecisionOutcome,
  reason: string,
  startTime: number,
): DecisionTrace {
  const result = historyOutcomeToTraceOutcome(outcome);
  return {
    toolName,
    finalOutcome: result,
    steps: [createTraceStep(historyOutcomeToLayer(outcome), outcome, result, reason, startTime)],
    totalDurationMs: Date.now() - startTime,
  };
}
