// ============================================================================
// Appshots Store — 待发送 appshot 的全局状态
// 监听器（useAppshots）写入，composer（ChatInput）读取并在发送时清理。
// ============================================================================

import { create } from 'zustand';
import type { AppshotCapture } from '@shared/contract/appshot';

interface AppshotsState {
  /** 当前待随下一条消息发送的 appshot（null = 无） */
  pending: AppshotCapture | null;
  /** pending 归属的会话；null 只用于尚未绑定会话的新 composer。 */
  pendingSessionId: string | null;
  /** 热键已触发、捕获进行中（用于轻量 loading 反馈） */
  starting: boolean;
  /** capture_starting 时的会话，用于避免异步抓取完成后串到新会话。 */
  startingSessionId: string | null;
  setPending: (capture: AppshotCapture | null, sessionId: string | null) => void;
  setStarting: (value: boolean, sessionId: string | null) => void;
  clear: () => void;
}

export const useAppshotsStore = create<AppshotsState>((set) => ({
  pending: null,
  pendingSessionId: null,
  starting: false,
  startingSessionId: null,
  setPending: (capture, sessionId) => set({
    pending: capture,
    pendingSessionId: capture ? sessionId : null,
    starting: false,
    startingSessionId: null,
  }),
  setStarting: (value, sessionId) => set({
    starting: value,
    startingSessionId: value ? sessionId : null,
  }),
  clear: () => set({
    pending: null,
    pendingSessionId: null,
    starting: false,
    startingSessionId: null,
  }),
}));
