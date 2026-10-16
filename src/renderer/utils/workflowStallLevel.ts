// ============================================================================
// Workflow stall level — 从 ScriptRunSnapshot 推导两级「无进展」提示（N-WF-STALL-UI）。
// 阈值单一真源 WORKFLOW_STALL_THRESHOLDS：N_SOFT_MS = UI 软提示（暂无进展），
// N_HARD_MS = 硬停顿（宿主检测器此时已提醒 Neo，UI 才敢说「已提醒」）。
// ============================================================================

import type { ScriptRunSnapshot } from '@shared/contract/scriptRun';
import { WORKFLOW_STALL_THRESHOLDS } from '@shared/constants';

type WorkflowStallLevel = 'none' | 'quiet' | 'long';

/**
 * 纯函数：快照 + 当前时间 → 停顿档位。
 * - 非 running 或 parked（等审批/审查）→ 'none'：等待用户不算卡住。
 * - 'long' 要求 stallNoticeEpoch >= 1 且 idle > N_HARD_MS：宿主确实公告过，
 *   「已提醒 Neo」的文案才不会说谎（in-flight agent call 档检测器要等 SINGLE_CALL_MS，
 *   中间空档仍是 'quiet'）。
 * - idle 只统计到最近真实活动（lastActivityAt），停顿状态事件不刷它（reducer 契约）。
 */
export function deriveWorkflowStallLevel(snapshot: ScriptRunSnapshot, now: number): WorkflowStallLevel {
  if (snapshot.status !== 'running' || snapshot.parked) return 'none';
  const anchor = snapshot.lastActivityAt ?? snapshot.startedAt;
  if (anchor === undefined) return 'none'; // fail-closed：没有可算的锚点就不误报
  const idle = now - anchor;
  if ((snapshot.stallNoticeEpoch ?? 0) >= 1 && idle > WORKFLOW_STALL_THRESHOLDS.N_HARD_MS) return 'long';
  if (idle > WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS) return 'quiet';
  return 'none';
}
