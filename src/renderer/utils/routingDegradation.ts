// ============================================================================
// routingDegradation —— routing_resolved 降级信号的 renderer 侧处理（S2 显式化）
// ----------------------------------------------------------------------------
// host 发来的 routing_resolved 携带 requestedAgentId（用户显式 /agent 请求）；
// 与实际 agentId 不一致即显式选择未生效（解析失败回落 default / 自动路由兜底）。
// 此前这条路径完全静默（host 只打 warn 日志），chip 会继续谎报「当前 agent: X」。
// 处理：清除该会话的 per-session 选择 + 当前会话可见 toast 警示。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { toast } from '../hooks/useToast';
import { languages } from '../i18n';
import type { RoutingResolvedPayload } from '../hooks/agent/effects/streamEventTypes';

/** 返回 true = 本次事件是降级信号且已处理 */
export function applyRoutingDegradationSignal(
  sessionId: string,
  payload: RoutingResolvedPayload,
): boolean {
  const requested = payload.requestedAgentId;
  if (!requested || requested === payload.agentId) return false;

  const app = useAppStore.getState();
  // 只清除事件所属会话的选择；chip/envelope 读的是当前会话值，
  // 其他会话的降级在其切回时经 per-session map 同步（此处直接清 map 条目）。
  if (app.activeAgentSessionKey === sessionId && app.activeAgentId === requested) {
    app.setActiveAgentId(null);
  } else {
    app.clearActiveAgentForSession(sessionId, { onlyIfAgentId: requested });
  }

  if (useSessionStore.getState().currentSessionId === sessionId) {
    const t = languages[app.language];
    toast.warning(
      `${t.agentCommand.degradedToastPrefix}${requested}${t.agentCommand.degradedToastMiddle}${payload.agentName}${t.agentCommand.degradedToastSuffix}`,
    );
  }
  return true;
}
