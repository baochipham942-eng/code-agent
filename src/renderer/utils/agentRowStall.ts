// ============================================================================
// agentRowStall - 代理行「暂无进展」判定（N-FIX-WF-STALL-SPAWN-AGENT）
// ----------------------------------------------------------------------------
// spawn_agent 子代理不出现在 workflow 检测器（那是 workflow 工具专属的 durable
// run/epoch 体系），静默思考时右栏「专家」行只会一直说「工作中」。这里按同一套
// 阈值（WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS，单一真源）给行级一个 UI 软提示：
// 行在工作中、不在等审批、且距最近可见进展锚点超过软阈值 → 报 quiet。
// 锚点 = member.lastActivityAt（contextSnapshot.lastUpdated ?? startTime，
// 见 SessionMemberBar 的填充）；前台 spawn_agent 渲染的是 agentTree 节点行（无 member），
// 改用 node.lastToolStep.at ?? node.updatedAt ?? node.createdAt（这三者只随真实事件前进，
// 无心跳写入；纯思考轮不动）。没有锚点一律不报（fail-closed，不猜）。
// ============================================================================

import { WORKFLOW_STALL_THRESHOLDS } from '@shared/constants';
import type { AgentRow } from './agentRows';

/**
 * 纯函数：代理行 + 当前时间 → 是否「暂无进展」（quiet 软提示档）。
 * - 只看 working 行：done/failed/cancelled/waiting/standby 都有自己的话，不叠这句。
 * - 等审批（hold === 'approval'）不算卡住：那是用户在等，不是代理在等。
 * - 无锚点（非专家行 / 预选名单 / 数据缺失）→ false：宁可不说，不误报。
 */
export function isAgentRowQuiet(row: AgentRow, now: number): boolean {
  if (row.status !== 'working') return false;
  if (row.hold === 'approval') return false;
  // 并入专家行的节点仍用 member 锚点；只有纯节点行（无 member）才走节点锚点
  const anchor = row.member
    ? row.member.lastActivityAt
    : row.kind === 'agent'
      ? (row.node?.lastToolStep?.at ?? row.node?.updatedAt ?? row.node?.createdAt)
      : undefined;
  if (anchor === undefined) return false; // fail-closed：没有可算的锚点就不误报
  return now - anchor > WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS;
}
