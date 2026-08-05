// ============================================================================
// Run Control Store —— 会话运行时控制面的跨面板投影（T1）
// ----------------------------------------------------------------------------
// 中断由 useAgent 拥有（只在 ChatView 里挂一次），而右栏 Overview 是另一棵
// 子树。这个 store 只投影既有 agent:cancel 动作，不重新实现运行时链路。
// ============================================================================

import { create } from 'zustand';

interface RunControlActions {
  /** = useAgent().cancel */
  interrupt: () => void | Promise<void>;
}

interface RunControlStore {
  /** null = 聊天运行时未挂载，Overview 不给动作按钮（不伪造可点入口） */
  actions: RunControlActions | null;
  publishActions: (actions: RunControlActions | null) => void;
}

export const useRunControlStore = create<RunControlStore>()((set) => ({
  actions: null,
  publishActions: (actions) => set({ actions }),
}));
