// ============================================================================
// streamResumeStore - 断流续接的流中信号（ADR-068 刀 4 / D5「一屏一个信号」）
// ============================================================================
// 同一时刻只有活动轮可能续接，所以信号是全局单例而不是按消息的 Map：信号挂在断流
// 那一刻的 streaming 消息上（B2 分段后即定格的断点段），n/N 随 stream_reconnecting
// 事件递增覆写；续答 delta（B1 回到同一消息 / B2 落到续答段）或终态一到即消除。
// 先例：voiceCallStore 的 reconnecting——同一通电话不重置，这里是同一轮回答不重置。
// ============================================================================

import { create } from 'zustand';

interface StreamResumeSignal {
  /** 断流轮的 turn id（事件寻址与终态对账用） */
  turnId: string;
  /** 状态行挂载的消息（断流时的 streaming 消息；B2 分段后它就是定格的断点段） */
  messageId: string;
  /** B2 分段另起的续答段消息 id（续答 delta 落在这里，也算恢复信号） */
  segmentMessageId?: string;
  /** 正在第几次续接（1 起） */
  attempt: number;
  /** 续接预算上限（状态行的 N） */
  maxReconnects: number;
  signaledAt: number;
}

interface StreamResumeStoreState {
  signal: StreamResumeSignal | null;
  setSignal: (signal: StreamResumeSignal) => void;
  /** B2 分段时补登记续答段消息 id */
  attachSegment: (segmentMessageId: string) => void;
  /** 恢复探测：命中挂载消息或续答段消息的流活动（delta/commit）即消除信号 */
  resolveIfActivityOn: (messageId: string | null | undefined) => void;
  /** 终态兜底消除（error / agent_complete / agent_cancelled / turn_end） */
  clear: () => void;
}

export const useStreamResumeStore = create<StreamResumeStoreState>()((set, get) => ({
  signal: null,
  setSignal: (signal) => set({ signal }),
  attachSegment: (segmentMessageId) => {
    const current = get().signal;
    if (!current) return;
    set({ signal: { ...current, segmentMessageId } });
  },
  resolveIfActivityOn: (messageId) => {
    const current = get().signal;
    if (!current || !messageId) return;
    if (messageId !== current.messageId && messageId !== current.segmentMessageId) return;
    set({ signal: null });
  },
  clear: () => set({ signal: null }),
}));
