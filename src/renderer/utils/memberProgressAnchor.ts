// ============================================================================
// memberProgressAnchor - 成员行「最近可见进展」活锚点（N-FIX-WF-STALL-SPAWN-AGENT r4）
// ----------------------------------------------------------------------------
// 账本记录转出的 state 不带 contextSnapshot（MemberConversationView 同结论：快照只在
// 流里、账本不存），所以锚点只认会随真实进展前进的活源——传入 state 自带的
// contextSnapshot.lastUpdated（live 输入时）与同 id 的 swarmStore 流状态快照，取最新。
// 没有活源返回 undefined（fail-closed：宁可不说，不拿 startTime 充当进展）。
// 消费方：SessionMemberBar.fromAgents（同 id 查表在调用方做，helper 只管两路快照取最新）。
// ============================================================================

import type { SwarmAgentState } from '@shared/contract/swarm';

export function memberProgressAnchor(
  agent: SwarmAgentState,
  liveAgent?: SwarmAgentState,
): number | undefined {
  const candidates = [agent.contextSnapshot?.lastUpdated, liveAgent?.contextSnapshot?.lastUpdated]
    .filter((value): value is number => typeof value === 'number');
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}
