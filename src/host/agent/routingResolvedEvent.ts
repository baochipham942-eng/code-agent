// ============================================================================
// routingResolvedEvent —— routing_resolved 事件载荷的单一构造真源
// ----------------------------------------------------------------------------
// orchestrator（IPC 路径）与 /api/agent/run（web 生产路径）共用，消灭两处手写
// 载荷的形状漂移。requestedAgentId 携带用户显式 /agent 请求的 agent id：
// 与 agentId 一致 → mode='explicit'（显式命中）；不一致 → 显式解析失败后的
// 降级（auto 兜底命中其他 agent，或 web 路径无自动路由直接回落 default）。
// ============================================================================

import type { RoutingResolvedEventData } from '../../shared/contract/agent';

export interface RoutingResolvedInput {
  agent: { id: string; name: string };
  score: number;
  reason: string;
}

export function buildRoutingResolvedEventData(
  resolution: RoutingResolvedInput | null,
  opts: {
    requestedAgentId?: string;
    timestamp: number;
    /** 兜底场景的实际执行者展示名（如外部引擎 kind）；默认 'default' */
    fallbackAgentName?: string;
    /** 兜底场景的自定义 reason（如"引擎会话不支持 agent 选择"）；默认 unavailable 文案 */
    fallbackReason?: string;
  },
): RoutingResolvedEventData {
  const requested = opts.requestedAgentId;

  if (resolution) {
    const explicitHit = Boolean(requested && resolution.agent.id === requested);
    return {
      mode: explicitHit ? 'explicit' : 'auto',
      agentId: resolution.agent.id,
      agentName: resolution.agent.name,
      reason: resolution.reason,
      score: resolution.score,
      fallbackToDefault: false,
      ...(requested ? { requestedAgentId: requested } : {}),
      timestamp: opts.timestamp,
    };
  }

  return {
    mode: requested ? 'explicit' : 'auto',
    agentId: 'default',
    agentName: opts.fallbackAgentName ?? 'default',
    reason: opts.fallbackReason ?? (requested
      ? `Requested agent "${requested}" is unavailable; continuing with the default conversation loop.`
      : 'No specialized agent matched; continue with the default conversation loop.'),
    score: 0,
    fallbackToDefault: true,
    ...(requested ? { requestedAgentId: requested } : {}),
    timestamp: opts.timestamp,
  };
}
