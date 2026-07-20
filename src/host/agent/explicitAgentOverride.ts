// ============================================================================
// explicitAgentOverride — /agent 显式选择在独立 run 路径上的统一解析
// ----------------------------------------------------------------------------
// 桌面 Electron 路径经 agentAppService → workbenchTurnContext → orchestrator
// 的 agentOverrideId 已消费 preferredAgentId；web/CLI 的 /api/run 独立 HTTP
// 路径此前完全丢弃它（与 executionIntent 当年同款漏接），导致生产 web 路径上
// /agent 选择是 no-op。此模块给独立路径提供与 orchestrator
// resolveExplicitAgentRouting 对齐的语义：换 systemPrompt + readonly 拒写。
// ============================================================================

import { getPredefinedAgent } from './agentDefinition';
import { buildRoutingToolDenylist } from './routingToolPolicy';

export interface ExplicitAgentOverride {
  id: string;
  name: string;
  systemPrompt: string;
  deniedToolNames: string[];
}

/** 解析显式选择的 agent；未知 id / 空值返回 null（回退自动路由，不阻断 run） */
export function resolveExplicitAgentOverride(
  agentId: string | null | undefined,
): ExplicitAgentOverride | null {
  if (!agentId?.trim()) return null;
  try {
    const agent = getPredefinedAgent(agentId.trim());
    return {
      id: agent.id,
      name: agent.name,
      systemPrompt: agent.prompt,
      deniedToolNames: buildRoutingToolDenylist({
        readonly: agent.coordination?.readonly === true,
      }),
    };
  } catch {
    return null;
  }
}
