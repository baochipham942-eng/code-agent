// ============================================================================
// agentRowStall - 代理行「暂无进展」判定（N-FIX-WF-STALL-SPAWN-AGENT）
// ----------------------------------------------------------------------------
// spawn_agent 子代理不出现在 workflow 检测器（那是 workflow 工具专属的 durable
// run/epoch 体系），静默思考时右栏「专家」行只会一直说「工作中」。这里按同一套
// 阈值（WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS，单一真源）给行级一个 UI 软提示：
// 行在工作中、不在等审批、且距最近可见进展锚点超过软阈值 → 报 quiet。
// 锚点只认会随真实进展前进的活源（r4：startTime 不是进展，账本记录不带快照）：
//   - 专家行（member）：member.lastActivityAt（SessionMemberBar.memberProgressAnchor
//     从同 id 流状态的 contextSnapshot.lastUpdated 取）与并入节点的 lastToolStep.at
//     取最新；node.updatedAt 不算（有心跳写入风险）。两者都缺 → fail-closed 不报。
//   - 纯节点行（前台 spawn_agent，无 member）：node.lastToolStep.at ?? node.updatedAt
//     ?? node.createdAt（r3 实测这三者静默期不动，无心跳写入）。
// 没有锚点一律不报（fail-closed，不猜）。
// ============================================================================

import { WORKFLOW_STALL_THRESHOLDS } from '@shared/constants';
import type { AgentRow } from './agentRows';

/**
 * 纯函数：代理行 + 当前时间 → 是否「暂无进展」（quiet 软提示档）。
 * - 只看 working 行：done/failed/cancelled/waiting/standby 都有自己的话，不叠这句。
 * - 等审批（hold === 'approval'）不算卡住：那是用户在等，不是代理在等。
 * - 无活锚点（非专家行 / 预选名单 / 数据缺失）→ false：宁可不说，不误报。
 * - holdReleasedAt：审批放行的时刻。等审批期间锚点不动，放行后有效锚点取
 *   max(锚点, 放行时刻)，让用户点「允许」后重开一个完整软阈值窗口，而不是立刻亮提示。
 */
export function isAgentRowQuiet(row: AgentRow, now: number, holdReleasedAt?: number): boolean {
  if (row.status !== 'working') return false;
  if (row.hold === 'approval') return false;
  let anchor: number | undefined;
  if (row.member) {
    // 专家行：流状态快照（经 member.lastActivityAt）与并入节点的最近工具步，取最新
    const candidates = [row.member.lastActivityAt, row.node?.lastToolStep?.at]
      .filter((value): value is number => typeof value === 'number');
    anchor = candidates.length > 0 ? Math.max(...candidates) : undefined;
  } else if (row.kind === 'agent') {
    anchor = row.node?.lastToolStep?.at ?? row.node?.updatedAt ?? row.node?.createdAt;
  }
  if (anchor === undefined) return false; // fail-closed：没有可算的锚点就不误报
  if (holdReleasedAt !== undefined) anchor = Math.max(anchor, holdReleasedAt);
  return now - anchor > WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS;
}
