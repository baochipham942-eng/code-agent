// ============================================================================
// Appshots Store — 待发送 appshot 的全局状态
// 监听器（useAppshots）写入，composer（ChatInput）读取并在发送时清理。
// ============================================================================

import { create } from 'zustand';
import type { AppshotCapture } from '@shared/contract/appshot';

interface AppshotsState {
  /** 当前待随下一条消息发送的 appshot（null = 无） */
  pending: AppshotCapture | null;
  /** 热键已触发、捕获进行中（用于轻量 loading 反馈） */
  starting: boolean;
  setPending: (capture: AppshotCapture | null) => void;
  setStarting: (value: boolean) => void;
  clear: () => void;
}

export const useAppshotsStore = create<AppshotsState>((set) => ({
  pending: null,
  starting: false,
  setPending: (capture) => set({ pending: capture, starting: false }),
  setStarting: (value) => set({ starting: value }),
  clear: () => set({ pending: null, starting: false }),
}));
