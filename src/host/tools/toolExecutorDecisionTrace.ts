// ============================================================================
// ToolExecutor - 权限决策记录与 decision trace 构建
// 从 toolExecutor.ts 抽出，无行为变更（ADR-022 事件账本第一期）。
// ============================================================================

import type { ToolLedgerOrigin } from '../../shared/constants/toolLedger';
import { getToolLedgerSink } from './toolLedgerSink';
import { getDecisionHistory, type DecisionOutcome as HistoryDecisionOutcome } from '../security/decisionHistory';
import type {
  DecisionLayer,
  DecisionOutcome as TraceDecisionOutcome,
  DecisionTrace,
} from '../../shared/contract/decisionTrace';

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
    timestamp: now, toolName, summary, outcome, reason,
    durationMs,
    decisionTrace,
  });
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
    });
  } catch {
    // 静默：账本写入永不阻断主流程
  }
}

function historyOutcomeToTraceOutcome(outcome: HistoryDecisionOutcome): TraceDecisionOutcome {
  if (outcome === 'auto-approve' || outcome === 'ask-approved' || outcome === 'policy-allow') return 'allow';
  return 'deny';
}

function historyOutcomeToLayer(outcome: HistoryDecisionOutcome): DecisionLayer {
  if (outcome === 'policy-allow' || outcome === 'policy-deny' || outcome === 'monitor-blocked') {
    return outcome === 'monitor-blocked' ? 'guard_fabric' : 'policy_enforcer';
  }
  if (outcome === 'classifier-deny' || outcome === 'auto-approve') return 'permission_classifier';
  if (outcome === 'hook-blocked') return 'plugin_hook';
  return 'plan_approval';
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
    steps: [{
      layer: historyOutcomeToLayer(outcome),
      rule: outcome,
      result,
      reason,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    }],
    totalDurationMs: Date.now() - startTime,
  };
}
