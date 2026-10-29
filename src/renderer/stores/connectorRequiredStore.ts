// ============================================================================
// connectorRequiredStore —— 聊天内连接卡的状态（仅会话内存，刷新即丢，已知限制）
// ============================================================================
// 以 session+connector 为键：pending（等连接）/ resuming（已发续跑消息）/ dismissed（用户点「稍后」）。
// resuming 的唯一入口是 claimResume——只有 pending 能抢到，这是「续跑消息只发一次」的守卫。
// ============================================================================

import { create } from 'zustand';
import type { ConnectorRequiredItem } from '@shared/contract/agent';

export type ConnectorRequiredStatus = 'pending' | 'resuming' | 'dismissed';

export interface ConnectorRequiredEntry {
  sessionId: string;
  connectorId: string;
  source: ConnectorRequiredItem['source'];
  reason: string;
  status: ConnectorRequiredStatus;
  /** 轮询到顶仍未连上：卡片改露手动「我已连好，继续」。 */
  gaveUp: boolean;
  polls: number;
}

interface ConnectorRequiredState {
  entries: Record<string, ConnectorRequiredEntry>;
  report: (sessionId: string, items: ConnectorRequiredItem[]) => void;
  dismiss: (sessionId: string, connectorId: string) => void;
  claimResume: (sessionId: string, connectorId: string) => boolean;
  recordPoll: (sessionId: string, connectorId: string, cap: number) => void;
}

export function connectorRequiredKey(sessionId: string, connectorId: string): string {
  return `${sessionId}::${connectorId}`;
}

export const useConnectorRequiredStore = create<ConnectorRequiredState>((set, get) => ({
  entries: {},

  report: (sessionId, items) => set((state) => {
    const entries = { ...state.entries };
    for (const item of items) {
      const key = connectorRequiredKey(sessionId, item.id);
      // 「稍后」对该会话+连接器永久静音；其余状态（含已续跑过又掉线）重新回到 pending
      if (entries[key]?.status === 'dismissed') continue;
      entries[key] = {
        sessionId,
        connectorId: item.id,
        source: item.source,
        reason: item.reason,
        status: 'pending',
        gaveUp: false,
        polls: 0,
      };
    }
    return { entries };
  }),

  dismiss: (sessionId, connectorId) => set((state) => {
    const key = connectorRequiredKey(sessionId, connectorId);
    const entry = state.entries[key];
    if (!entry) return state;
    return { entries: { ...state.entries, [key]: { ...entry, status: 'dismissed' } } };
  }),

  claimResume: (sessionId, connectorId) => {
    const key = connectorRequiredKey(sessionId, connectorId);
    const entry = get().entries[key];
    if (entry?.status !== 'pending') return false;
    set((state) => ({ entries: { ...state.entries, [key]: { ...entry, status: 'resuming' } } }));
    return true;
  },

  recordPoll: (sessionId, connectorId, cap) => set((state) => {
    const key = connectorRequiredKey(sessionId, connectorId);
    const entry = state.entries[key];
    if (entry?.status !== 'pending' || entry.gaveUp) return state;
    const polls = entry.polls + 1;
    return { entries: { ...state.entries, [key]: { ...entry, polls, gaveUp: polls >= cap } } };
  }),
}));

/** SSE / IPC 载荷在 renderer 是 unknown：宽松解析，丢掉畸形项。 */
export function parseConnectorRequiredPayload(data: unknown): ConnectorRequiredItem[] {
  const connectors = (data as { connectors?: unknown } | null | undefined)?.connectors;
  if (!Array.isArray(connectors)) return [];
  return connectors.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, source, reason } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return [];
    return [{
      id,
      source: source === 'expert' ? 'expert' as const : 'selected' as const,
      reason: typeof reason === 'string' && reason ? reason : 'not_connected',
    }];
  });
}
