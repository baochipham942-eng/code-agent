// ============================================================================
// terminalRunGuardStore — 终态粘滞守卫（terminal-sticky）
// ============================================================================
// 一个 run 的终局（agent_complete / agent_cancelled / 终态 error / 终态
// session:updated）被 renderer 应用之后，这个 run 的「尾巴」——收尾钩子的
// hook_started、关流的 stream_end、终局前读库的 session.load 响应、开跑时
// 发出的 running 广播——都不得把会话重新点亮成运行态（2026-10-16 表格卡
// 真跑实录：agent_complete 之后 7 秒 stream_end 把 taskStore 重淋上 running，
// Stop/侧栏 spinner/「正在整理回复…」三个表面一起卡死到 reload）。
// 再武装信号只有一个：turn_start——每个新 run 的第一个事件。刷新/切回的
// 重附着不受影响：新页面没有应用过终局，守卫天然放行（C3 语义保留）。
//
// 未收口 run 记录（unendedRuns，N-WORKDETAIL-DEFAULT-SIMPLE-FU2-FU2-FU1）：本页面
// 见过 turn_start、却还没见过这个 run 的收口事件（agent_complete / agent_cancelled /
// 终态 error）。它回答的问题与终态记录互补：终态广播和 agent_complete 都会写
// markTerminal，所以 hasTerminal 分不清「run 流送到了终局」还是只有广播到了；
// 而流式半途失联（部分正文已上屏、run 流再无事件）恰恰是「广播到了、终局事件
// 永远不会到」的形状——只有 unendedRuns 还开着这一点证据。stream_end 不算收口：
// httpTransport 在 reader 正常结束时也会合成 stream_end，它证明不了答案到过页面。
// 刷新/重开的新页面没见过 turn_start，记录天然为空，不会凭空触发对账。

import { create } from 'zustand';

export interface TerminalRunRecord {
  /** 终态 session:updated 携带的宿主 updatedAt 戳；只有 agent 事件终局时为 null。 */
  stamp: number | null;
}

interface TerminalRunGuardState {
  terminalBySession: Map<string, TerminalRunRecord>;
  unendedRuns: Set<string>;
  markTerminal: (sessionId: string, stamp?: number | null) => void;
  rearmForNewRun: (sessionId: string) => void;
  markRunEndObserved: (sessionId: string) => void;
  hasTerminal: (sessionId: string) => boolean;
  hasUnendedRun: (sessionId: string) => boolean;
}

export const useTerminalRunGuardStore = create<TerminalRunGuardState>((set, get) => ({
  terminalBySession: new Map<string, TerminalRunRecord>(),
  unendedRuns: new Set<string>(),
  markTerminal: (sessionId, stamp = null) => {
    const previous = get().terminalBySession.get(sessionId);
    // 同一收尾窗口 agent_complete 与终态广播都会到：戳取有值的一方（广播更知情）。
    // 注意：终态广播本身不动 unendedRuns——广播健康不代表 run 流把终局事件送到了。
    const merged: TerminalRunRecord = { stamp: stamp ?? previous?.stamp ?? null };
    set((state) => ({ terminalBySession: new Map(state.terminalBySession).set(sessionId, merged) }));
  },
  rearmForNewRun: (sessionId) => {
    set((state) => {
      const nextTerminal = new Map(state.terminalBySession);
      nextTerminal.delete(sessionId);
      const nextUnended = new Set(state.unendedRuns);
      nextUnended.add(sessionId);
      return { terminalBySession: nextTerminal, unendedRuns: nextUnended };
    });
  },
  markRunEndObserved: (sessionId) => {
    set((state) => {
      if (!state.unendedRuns.has(sessionId)) return state;
      const next = new Set(state.unendedRuns);
      next.delete(sessionId);
      return { unendedRuns: next };
    });
  },
  hasTerminal: (sessionId) => get().terminalBySession.has(sessionId),
  hasUnendedRun: (sessionId) => get().unendedRuns.has(sessionId),
}));

/**
 * 宿主戳是否早于已应用的终态广播戳——即「终局之前」的旧回声。两个消费方：
 * session.load 响应（读库发生在终态落库前，activeRun/status 是旧 run 残影）与
 * 开跑时发出的 running 广播（终局后迟到）。无戳（还没收到终态广播）时不拦，
 * 后续终态广播到达自会收线。
 */
export function hostStampPredatesTerminal(
  sessionId: string,
  hostUpdatedAt: number | undefined,
): boolean {
  const record = useTerminalRunGuardStore.getState().terminalBySession.get(sessionId);
  if (!record?.stamp || typeof hostUpdatedAt !== 'number') return false;
  return hostUpdatedAt < record.stamp;
}
